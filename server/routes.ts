import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { storage } from "./storage";
import { generateAIResponse, generateAIBackground } from "./openai";
import { ThreadManager } from "./thread-manager";
import { ResponseScheduler } from "./response-scheduler";
import { ThreadContextManager } from "./context-manager";
import { getAvailableTools } from "./tools";
import { IStorage } from "./storage";
import { User } from "@shared/schema";
import nftRoutes from "./blockchain/routes";
import { cloneFollowers } from "./clone-service";

async function hasCirclePermission(
  circleId: number,
  userId: number,
  storage: IStorage,
  requiredRole: "owner" | "collaborator" | "viewer" = "viewer"
): Promise<boolean> {
  console.log("[Permissions] Checking permissions:", { circleId, userId, requiredRole });

  const circle = await storage.getCircle(circleId);
  if (!circle) {
    console.log("[Permissions] Circle not found:", circleId);
    return false;
  }

  // Circle owner has all permissions
  if (circle.userId === userId) {
    console.log("[Permissions] User is circle owner, granting all permissions");
    return true;
  }

  // Check member role
  const members = await storage.getCircleMembers(circleId);
  const member = members.find(m => m.userId === userId);

  // Check if user has a pending invitation
  const invitations = await storage.getUserPendingInvitations(userId);
  const hasPendingInvitation = invitations.some(inv => inv.circleId === circleId && inv.status === "pending");

  if (hasPendingInvitation) {
    console.log("[Permissions] User has pending invitation, granting viewer access");
    return requiredRole === "viewer";
  }

  if (!member) {
    console.log("[Permissions] User is not a member of the circle");
    return false;
  }

  console.log("[Permissions] User role:", member.role);

  switch (requiredRole) {
    case "owner":
      console.log("[Permissions] Owner permission required, denying non-owner");
      return false;
    case "collaborator":
      const hasCollabPermission = member.role === "collaborator";
      console.log("[Permissions] Collaborator permission check:", hasCollabPermission);
      return hasCollabPermission;
    case "viewer":
      console.log("[Permissions] Viewer permission granted");
      return true;
    default:
      console.log("[Permissions] Unknown role requested:", requiredRole);
      return false;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  await setupAuth(app);
  const httpServer = createServer(app);

  // Start the response scheduler
  const scheduler = ResponseScheduler.getInstance();
  scheduler.start();
  
  // Add user profile update endpoint
  app.patch("/api/user/profile", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    console.log("[API] PATCH /api/user/profile - Request received");
    console.log("[API] Request body:", req.body);
    
    try {
      const updates: Partial<Pick<User, "avatarUrl" | "bio">> = {};
      
      // Only include provided fields
      if (req.body.avatarUrl !== undefined) {
        updates.avatarUrl = req.body.avatarUrl;
      }
      
      if (req.body.bio !== undefined) {
        updates.bio = req.body.bio;
      }
      
      // Update the user profile
      const updatedUser = await storage.updateUser(req.user!.id, updates);
      console.log("[API] User profile updated successfully");
      
      res.json(updatedUser);
    } catch (error) {
      console.error("[API] Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update user profile" });
    }
  });

  // Add new delete-all endpoint before the existing notification routes
  app.delete("/api/notifications/delete-all", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      // Delete all notifications for the current user
      // Requires importing db and notifications from database library (e.g., knex)
      // const { db, notifications } = require('./database'); //Example - Needs proper import based on your DB setup.
      //await db.delete().from('notifications').where({userId: req.user!.id}); // Example using Knex - Adapt to your ORM
      await storage.deleteAllNotifications(req.user!.id); // Assuming storage has this method.
      res.sendStatus(200);
    } catch (error) {
      console.error("Error deleting all notifications:", error);
      res.status(500).json({ message: "Failed to delete all notifications" });
    }
  });


  // Add notification routes
  app.get("/api/notifications", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const notifications = await storage.getUserNotifications(req.user!.id);
      res.json(notifications);
    } catch (error) {
      console.error("Error getting notifications:", error);
      res.status(500).json({ message: "Failed to get notifications" });
    }
  });

  app.get("/api/notifications/unread/count", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const count = await storage.getUnreadNotificationCount(req.user!.id);
      res.json({ count });
    } catch (error) {
      console.error("Error getting unread notification count:", error);
      res.status(500).json({ message: "Failed to get unread notification count" });
    }
  });

  app.patch("/api/notifications/:id/read", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const notificationId = parseInt(req.params.id);
    try {
      await storage.markNotificationRead(notificationId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  });

  app.patch("/api/notifications/read-all", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      await storage.markAllNotificationsRead(req.user!.id);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      res.status(500).json({ message: "Failed to mark all notifications as read" });
    }
  });

  app.delete("/api/notifications/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const notificationId = parseInt(req.params.id);
    try {
      await storage.deleteNotification(notificationId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error deleting notification:", error);
      res.status(500).json({ message: "Failed to delete notification" });
    }
  });

  // Update the Get pending invitations endpoint to include circle information
  app.get("/api/circles/invitations/pending", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const invitations = await storage.getUserPendingInvitations(req.user!.id);

      // Get circle information for each invitation
      const invitationsWithCircles = await Promise.all(
        invitations.map(async (invitation) => {
          const circle = await storage.getCircle(invitation.circleId);
          return {
            ...invitation,
            circle
          };
        })
      );

      res.json(invitationsWithCircles);
    } catch (error) {
      console.error("Error getting pending invitations:", error);
      res.status(500).json({ message: "Failed to get pending invitations" });
    }
  });
  // Create invitation for a circle
  app.post("/api/circles/:id/invitations", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    const { username, role } = req.body;

    try {
      // Verify circle ownership and existence
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      // Get invitee user by username
      const invitee = await storage.getUserByUsername(username);
      if (!invitee) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if user is already a member
      const members = await storage.getCircleMembers(circleId);
      if (members.some(member => member.userId === invitee.id)) {
        return res.status(400).json({ message: "User is already a member of this circle" });
      }

      // Check for existing pending invitation
      const invitations = await storage.getCircleInvitations(circleId);
      if (invitations.some(inv => inv.inviteeId === invitee.id && inv.status === "pending")) {
        return res.status(400).json({ message: "User already has a pending invitation" });
      }

      // Create invitation
      const invitation = await storage.createCircleInvitation({
        circleId,
        inviterId: req.user!.id,
        inviteeId: invitee.id,
        role
      });

      // Update circle visibility to shared
      if (circle.visibility === "private") {
        await storage.updateCircle(circleId, { visibility: "shared" });
      }

      res.status(201).json(invitation);
    } catch (error) {
      console.error("Error creating invitation:", error);
      res.status(500).json({ message: "Failed to create invitation" });
    }
  });

  // Respond to an invitation
  app.patch("/api/circles/invitations/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const invitationId = parseInt(req.params.id);
    const { status } = req.body;

    try {
      const invitation = await storage.getCircleInvitation(invitationId);
      if (!invitation || invitation.inviteeId !== req.user!.id) {
        return res.status(404).json({ message: "Invitation not found" });
      }

      if (invitation.status !== "pending") {
        return res.status(400).json({ message: "Invitation has already been responded to" });
      }

      const updatedInvitation = await storage.updateInvitationStatus(invitationId, status);
      console.log(`[Invitations] Invitation ${invitationId} updated to status: ${status}`); //Added Log
      res.json(updatedInvitation);
    } catch (error) {
      console.error("Error responding to invitation:", error);
      res.status(500).json({ message: "Failed to respond to invitation" });
    }
  });

  // Add before other circle routes
  app.get("/api/circles/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    // Handle 'default' as a special case
    if (req.params.id === 'default') {
      try {
        const defaultCircle = await storage.getDefaultCircle(req.user!.id);
        res.json(defaultCircle);
      } catch (error) {
        console.error("Error getting default circle:", error);
        res.status(500).json({ message: "Failed to get default circle" });
      }
      return;
    }

    const circleId = parseInt(req.params.id);
    if (isNaN(circleId)) {
      return res.status(400).json({ message: "Invalid circle ID" });
    }

    try {
      // Check if user has access to this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage);
      if (!hasPermission) {
        return res.status(403).json({ message: "Access denied" });
      }

      const circle = await storage.getCircle(circleId);
      if (!circle) {
        return res.status(404).json({ message: "Circle not found" });
      }
      res.json(circle);
    } catch (error) {
      console.error("Error getting circle:", error);
      res.status(500).json({ message: "Failed to get circle" });
    }
  });


  // New Circle Management Routes
  app.get("/api/circles", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const circles = await storage.getUserCircles(req.user!.id);
      const deactivatedCircles = await storage.getDeactivatedCircles(req.user!.id);

      // Reorganize circles into the new grouping structure
      const categorizedCircles = {
        private: circles.owned.filter(c => c.visibility !== "shared"),
        shared: circles.owned.filter(c => c.visibility === "shared"),
        sharedWithYou: circles.shared,
        invited: circles.invited,
        deactivated: deactivatedCircles
      };

      res.json(categorizedCircles);
    } catch (error) {
      console.error("Error getting circles:", error);
      res.status(500).json({ message: "Failed to get circles" });
    }
  });
  
  // Get user's default circle
  app.get("/api/default-circle", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const defaultCircle = await storage.getDefaultCircle(req.user!.id);
      res.json(defaultCircle);
    } catch (error) {
      console.error("Error getting default circle:", error);
      res.status(500).json({ message: "Failed to get default circle" });
    }
  });

  app.post("/api/circles", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const circle = await storage.createCircle(req.user!.id, req.body);
      res.status(201).json(circle);
    } catch (error) {
      console.error("Error creating circle:", error);
      res.status(500).json({ message: "Failed to create circle" });
    }
  });

  app.patch("/api/circles/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Verify circle ownership
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      const updatedCircle = await storage.updateCircle(circleId, req.body);
      res.json(updatedCircle);
    } catch (error) {
      console.error("Error updating circle:", error);
      res.status(500).json({ message: "Failed to update circle" });
    }
  });

  // Endpoint to set a circle as default
  app.post("/api/circles/:id/set-default", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Verify circle ownership
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      const updatedCircle = await storage.setDefaultCircle(req.user!.id, circleId);
      res.json(updatedCircle);
    } catch (error) {
      console.error("Error setting default circle:", error);
      res.status(500).json({ message: "Failed to set default circle" });
    }
  });

  app.delete("/api/circles/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Verify circle ownership
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      if (circle.isDefault) {
        return res.status(400).json({ message: "Cannot delete default circle" });
      }

      await storage.deleteCircle(circleId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error deleting circle:", error);
      res.status(500).json({ message: "Failed to delete circle" });
    }
  });

  // Circle Followers Management
  app.post("/api/circles/:id/followers", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    const { aiFollowerId } = req.body;

    try {
      // Allow both owners and collaborators to manage followers
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage, "collaborator");
      if (!hasPermission) {
        return res.status(403).json({ message: "Insufficient permissions" });
      }

      // Verify AI follower ownership or availability
      const follower = await storage.getAiFollower(aiFollowerId);
      if (!follower) {
        return res.status(404).json({ message: "AI follower not found" });
      }

      const circleFollower = await storage.addFollowerToCircle(circleId, aiFollowerId);
      res.status(201).json(circleFollower);
    } catch (error) {
      console.error("Error adding follower to circle:", error);
      res.status(500).json({ message: "Failed to add follower to circle" });
    }
  });

  app.delete("/api/circles/:id/followers/:followerId", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    const aiFollowerId = parseInt(req.params.followerId);

    try {
      // Verify circle ownership
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      await storage.removeFollowerFromCircle(circleId, aiFollowerId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error removing follower from circle:", error);
      res.status(500).json({ message: "Failed to remove follower from circle" });
    }
  });

  app.get("/api/circles/:id/followers", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Check if user has access to this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage);
      if (!hasPermission) {
        return res.status(403).json({ message: "Access denied" });
      }

      const followers = await storage.getCircleFollowers(circleId);
      res.json(followers);
    } catch (error) {
      console.error("Error getting circle followers:", error);
      res.status(500).json({ message: "Failed to get circle followers" });
    }
  });

  // Toggle mute status for an AI follower within a specific circle
  app.patch("/api/circles/:id/followers/:followerId/toggle-mute", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const circleId = parseInt(req.params.id);
      const followerId = parseInt(req.params.followerId);
      
      if (isNaN(circleId) || isNaN(followerId)) {
        return res.status(400).json({ message: "Invalid circle ID or follower ID" });
      }

      // Check if user has access to this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage);
      if (!hasPermission) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Get the follower to ensure it exists
      const follower = await storage.getAiFollower(followerId);
      if (!follower) {
        return res.status(404).json({ message: "Follower not found" });
      }

      // Toggle the mute status
      const updatedCircleFollower = await storage.toggleFollowerMuteInCircle(circleId, followerId);
      
      // Return the updated follower with muted status
      res.json({
        ...follower,
        muted: updatedCircleFollower.muted
      });
    } catch (error) {
      console.error("Error toggling follower mute status:", error);
      res.status(500).json({ message: "Failed to toggle follower mute status" });
    }
  });

  // Update the existing post creation endpoint to support circles
  app.post("/api/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const circleId = req.body.circleId || (await storage.getDefaultCircle(req.user!.id)).id;

      // Check if user has permission to post in this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage, "collaborator");
      if (!hasPermission) {
        return res.status(403).json({ message: "Insufficient permissions to post in this circle" });
      }

      const post = await storage.createPostInCircle(req.user!.id, circleId, req.body.content);

      // Get AI followers for the specific circle
      const followers = await storage.getCircleFollowers(circleId);

      // Schedule potential responses for each follower in the circle
      for (const follower of followers) {
        await scheduler.scheduleResponse(post.id, follower);
      }

      res.status(201).json(post);
    } catch (error) {
      console.error("Error creating post:", error);
      res.status(500).json({ message: "Failed to create post" });
    }
  });

  // Update the circle posts route
  app.get("/api/circles/:id/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Check if user has access to this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage);
      if (!hasPermission) {
        return res.status(403).json({ message: "Access denied" });
      }

      const posts = await storage.getCirclePosts(circleId);

      // Get threaded interactions for each post
      const postsWithData = await Promise.all(
        posts.map(async (post) => {
          const threadedInteractions = await ThreadManager.getThreadedInteractions(post.id);
          const pendingResponses = await storage.getPostPendingResponses(post.id);

          // Get AI follower info for each pending response
          const pendingFollowers = await Promise.all(
            pendingResponses.map(async (response) => {
              const follower = await storage.getAiFollower(response.aiFollowerId);
              return follower ? {
                id: follower.id,
                name: follower.name,
                avatarUrl: follower.avatarUrl,
                scheduledFor: response.scheduledFor
              } : null;
            })
          );

          return {
            ...post,
            interactions: threadedInteractions,
            pendingResponses: pendingFollowers.filter(Boolean)
          };
        })
      );

      res.json(postsWithData);
    } catch (error) {
      console.error("Error getting circle posts:", error);
      res.status(500).json({ message: "Failed to get circle posts" });
    }
  });

  // Move a post to a different circle
  app.patch("/api/posts/:id/move", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const postId = parseInt(req.params.id);
    const { circleId } = req.body;

    try {
      // Verify post ownership
      const post = await storage.getPost(postId);
      if (!post || post.userId !== req.user!.id) {
        return res.status(404).json({ message: "Post not found" });
      }

      // Verify circle ownership
      const circle = await storage.getCircle(circleId);
      if (!circle || circle.userId !== req.user!.id) {
        return res.status(404).json({ message: "Circle not found" });
      }

      const updatedPost = await storage.movePostToCircle(postId, circleId);
      res.json(updatedPost);
    } catch (error) {
      console.error("Error moving post:", error);
      res.status(500).json({ message: "Failed to move post" });
    }
  });

  app.get("/api/posts/:userId", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      console.log("[Routes] Getting posts for user:", req.params.userId);
      const posts = await storage.getUserPosts(parseInt(req.params.userId));
      console.log("[Routes] Found posts:", posts.length);

      // Get threaded interactions and pending responses for each post
      const postsWithData = await Promise.all(
        posts.map(async (post) => {
          console.log("[Routes] Processing post:", post.id);
          const [threadedInteractions, pendingResponses] = await Promise.all([
            ThreadManager.getThreadedInteractions(post.id),
            storage.getPostPendingResponses(post.id)
          ]);

          console.log("[Routes] Pending responses for post", post.id, ":", pendingResponses);

          // Get AI follower info for each pending response
          const pendingFollowers = await Promise.all(
            pendingResponses.map(async (response) => {
              const follower = await storage.getAiFollower(response.aiFollowerId);
              console.log("[Routes] Found follower for response:", follower?.name);
              return follower ? {
                id: follower.id,
                name: follower.name,
                avatarUrl: follower.avatarUrl,
                scheduledFor: response.scheduledFor
              } : null;
            })
          );

          // Filter out null values and sort by scheduled time
          const validPendingFollowers = pendingFollowers
            .filter((f): f is NonNullable<typeof f> => f !== null)
            .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());

          console.log("[Routes] Valid pending followers for post", post.id, ":", validPendingFollowers);

          return {
            ...post,
            interactions: threadedInteractions,
            pendingResponses: validPendingFollowers
          };
        })
      );

      res.json(postsWithData);
    } catch (error) {
      console.error("Error getting posts:", error);
      res.status(500).json({ message: "Failed to get posts" });
    }
  });

  app.post("/api/posts/:postId/reply", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const { content, parentId } = req.body;
    const postId = parseInt(req.params.postId);

    try {
      // Get parent interaction and its AI follower
      const parentInteraction = await storage.getInteraction(parentId);
      if (!parentInteraction) {
        return res.status(404).json({ message: "Parent interaction not found" });
      }

      // Get the AI follower associated with the parent interaction
      const targetFollower = parentInteraction.aiFollowerId ?
        await storage.getAiFollower(parentInteraction.aiFollowerId)
        : null;
      if (!targetFollower) {
        return res.status(404).json({ message: "AI follower not found" });
      }

      // Save the user's reply
      const userReply = await storage.createAiInteraction({
        postId,
        userId: req.user!.id,
        aiFollowerId: null,
        type: "reply",
        content,
        parentId
      });
      
      console.log("[Routes] Created user reply:", {
        id: userReply.id,
        postId,
        parentId,
        content: content.substring(0, 50)
      });

      // Get circle associated with this post
      const post = await storage.getPost(postId);
      if (!post) {
        return res.status(404).json({ message: "Post not found" });
      }

      const circleId = post.circleId;
      
      // Store the thread context in the pending response metadata
      const contextManager = ThreadContextManager.getInstance();
      const threadContext = await contextManager.buildThreadContext(
        userReply,
        parentInteraction,
        targetFollower
      );
      
      // Serialize context data for storage with both parentId and parentInteractionId
      // (parentInteractionId is included for backwards compatibility)
      const contextMetadata = JSON.stringify({
        threadContext,
        parentId,
        parentInteractionId: parentId
      });
      
      // Similar to regular posts, we'll now schedule potential responses
      // First, calculate a quick scheduled time for the primary target follower (the one being replied to)
      const scheduler = ResponseScheduler.getInstance();
      
      // Schedule a response from the target follower with higher priority
      await scheduler.scheduleThreadResponse(postId, targetFollower, parentId, contextMetadata);
      
      // Additionally, get other followers in the circle who might want to join the conversation
      // but with lower priority and longer delay
      const circleFollowers = await storage.getCircleFollowers(circleId);
      const otherFollowers = circleFollowers.filter(f => f.id !== targetFollower.id);
      
      // If we have other followers, give them a chance to join the thread conversation
      for (const follower of otherFollowers) {
        // We use a lower relevance boost for other followers as they weren't directly addressed
        await scheduler.scheduleThreadResponse(postId, follower, parentId, contextMetadata, false);
      }

      // Get updated thread structure with interactions
      const threadedInteractions = await ThreadManager.getThreadedInteractions(postId);
      const updatedThread = ThreadManager.findThreadById(threadedInteractions, parentId);

      if (!updatedThread) {
        return res.status(500).json({ message: "Failed to find updated thread" });
      }
      
      // Get newly scheduled pending responses for this specific thread
      const pendingResponses = await storage.getPostPendingResponses(postId);
      console.log("[Routes] Pending responses for thread:", pendingResponses.length);
      
      // Filter for responses specifically targeting the parent interaction
      const filteredResponses = pendingResponses.filter(response => {
        try {
          if (!response.metadata) return false;
          const metadata = JSON.parse(response.metadata);
          return metadata.parentInteractionId === parentId || metadata.parentId === parentId;
        } catch (e) {
          return false;
        }
      });
      
      // Format pending responses with follower information
      const pendingFollowers = await Promise.all(
        filteredResponses.map(async (response) => {
          const follower = await storage.getAiFollower(response.aiFollowerId);
          return follower ? {
            id: follower.id,
            name: follower.name,
            avatarUrl: follower.avatarUrl,
            scheduledFor: response.scheduledFor
          } : null;
        })
      );
      
      // Filter out nulls and add to the updated thread
      const validPendingFollowers = pendingFollowers
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
      
      // Attach the pending responses to the thread
      if (validPendingFollowers.length > 0) {
        updatedThread.pendingResponses = validPendingFollowers;
      }
      
      console.log("[Routes] Thread reply response includes", 
        validPendingFollowers.length, "pending responses");

      res.status(201).json(updatedThread);
    } catch (error) {
      console.error("Error handling reply:", error);
      res.status(500).json({ message: "Failed to process reply" });
    }
  });


  // Get available AI follower tools
  app.get("/api/tools", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      // Get available tools without exposing implementation details
      const tools = getAvailableTools();
      res.json(tools);
    } catch (error) {
      console.error("Error getting available tools:", error);
      res.status(500).json({ message: "Failed to get available tools" });
    }
  });

  app.post("/api/followers", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const aiBackground = await generateAIBackground(
        req.body.name,
        req.body.personality
      );

      // Create follower with the generated background and responsiveness settings
      const follower = await storage.createAiFollower(req.user!.id, {
        name: req.body.name,
        personality: req.body.personality,
        avatarUrl: req.body.avatarUrl,
        background: aiBackground.background,
        interests: aiBackground.interests,
        communicationStyle: aiBackground.communication_style,
        interactionPreferences: aiBackground.interaction_preferences,
        responsiveness: req.body.responsiveness || "active",
        responseDelay: getDefaultDelay(req.body.responsiveness),
        responseChance: req.body.responseChance || 80,
      });

      res.status(201).json(follower);
    } catch (error) {
      console.error("Error creating AI follower:", error);
      res.status(500).json({ message: "Failed to create AI follower" });
    }
  });
  
  // Create an AI collective (multiple followers at once)
  app.post("/api/followers/collective", async (req, res) => {
    console.log("[API] POST /api/followers/collective - Received request");
    console.log("[API] Request body:", req.body);
    console.log("[API] User authenticated:", req.isAuthenticated());
    
    if (!req.isAuthenticated()) {
      console.log("[API] Request rejected: User not authenticated");
      return res.sendStatus(401);
    }

    const { 
      collectiveName, 
      personality, 
      count, 
      avatarPrefix,
      responsiveness,
      responsivenessOptions = [],
      responseDelay,
      responseChance,
      namingOption = 'sequential',
      generateDynamicAvatars = false
    } = req.body;
    
    console.log("[API] Extracted values:", {
      collectiveName, 
      personality, 
      count,
      responsivenessOptions,
      namingOption
    });
    
    if (!collectiveName || !personality || !count || count < 1 || count > 100) {
      console.log("[API] Request rejected: Invalid request parameters");
      return res.status(400).json({ 
        message: "Invalid request. Must provide collectiveName, personality, and a count between 1-100" 
      });
    }
    
    // Validate naming option
    if (namingOption !== 'sequential' && namingOption !== 'dynamic') {
      return res.status(400).json({
        message: "Invalid namingOption. Must be 'sequential' or 'dynamic'"
      });
    }

    try {
      console.log(`[API] Creating AI collective: ${collectiveName} with ${count} members`);
      
      // Generate a collective background that will be used as a base for all members
      const collectiveBackground = await generateAIBackground(
        collectiveName,
        personality
      );

      // First, create the collective in the database
      const collective = await storage.createAiFollowerCollective(req.user!.id, {
        name: collectiveName,
        description: `A collective of ${count} AI followers with the personality: ${personality.substring(0, 50)}...`,
        personality,
      });
      
      console.log(`[API] Created collective: ${collective.id}`);
      
      const createdFollowers = [];
      
      // Create multiple followers with small variations
      for (let i = 0; i < count; i++) {
        // Apply naming strategy
        let followerName = '';
        let avatarUrl = null;
        let nameInstruction = '';
        
        // Determine how to generate follower name
        if (namingOption === 'sequential') {
          // Sequential naming: just add a number suffix
          followerName = `${collectiveName} ${i + 1}`;
          
          // Use a default avatar if none provided to avoid database not-null constraint
          avatarUrl = avatarPrefix 
            ? `${avatarPrefix}-${i + 1}.png` 
            : `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(followerName)}`;
            
          // If dynamic avatar generation is requested, override with a unique avatar
          if (generateDynamicAvatars) {
            const seed = encodeURIComponent(`${followerName}-${Math.random().toString(36).substring(2, 8)}`);
            avatarUrl = `https://api.dicebear.com/9.x/bottts/svg?seed=${seed}`;
          }
        } else {
          // For dynamic naming, we'll add an instruction to generate a unique name
          followerName = `${collectiveName} Variation ${i + 1}`;
          nameInstruction = `Generate a unique character name that reflects a member of the ${collectiveName} collective with the personality described. The name should be creative and distinct.`;
          
          // Generate a placeholder avatar URL that will be replaced if generateDynamicAvatars is true
          avatarUrl = `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(followerName)}`;
        }
        
        // Generate background variations with naming instructions
        let fullPrompt = personality;
        if (nameInstruction) {
          fullPrompt = `${personality}\n\n${nameInstruction}`;
        }
        
        // For dynamic naming, generate a unique background for each follower
        let followerBackground;
        if (namingOption === 'dynamic') {
          followerBackground = await generateAIBackground(
            followerName,
            fullPrompt,
            `This is member #${i + 1} of ${count} in the ${collectiveName} collective.`
          );
          
          // If using dynamic naming, extract the name from the background
          // Format: "Name: [character name]" or similar
          if (followerBackground.background.includes("Name:")) {
            // Try different regex patterns to extract the name
            let nameMatch = followerBackground.background.match(/Name:\s*([^\n\.]+)/i);
            
            // If first pattern doesn't work, try a more general one
            if (!nameMatch || !nameMatch[1]) {
              nameMatch = followerBackground.background.match(/Name:\s*([^\.]+)/i);
            }
            
            if (nameMatch && nameMatch[1]) {
              // Get the extracted name and clean it up
              followerName = nameMatch[1].trim();
              
              // Clean up the background by removing the name line
              followerBackground.background = followerBackground.background
                .replace(/Name:\s*([^\n\.]+)(\n+|\.)/i, "") 
                .replace(/Name:\s*([^\.]+)/i, "")
                .trim();
            }
          }
          
          // Generate avatar if requested (independent of naming option)
          if (generateDynamicAvatars) {
            // Generate a unique seed based on the follower's name
            const seed = encodeURIComponent(`${followerName}-${Math.random().toString(36).substring(2, 8)}`);
            avatarUrl = `https://api.dicebear.com/9.x/bottts/svg?seed=${seed}`;
          }
        } else {
          // For sequential naming, use collective background with minor variations
          followerBackground = {
            background: collectiveBackground.background,
            interests: [...collectiveBackground.interests],
            communication_style: collectiveBackground.communication_style,
            interaction_preferences: {
              likes: [...collectiveBackground.interaction_preferences.likes],
              dislikes: [...collectiveBackground.interaction_preferences.dislikes]
            }
          };
        }
        
        // Select a random responsiveness option if multiple options are provided
        const selectedResponsiveness = responsivenessOptions.length > 0 
          ? getRandomItem(responsivenessOptions) 
          : (responsiveness || "active");
        
        // Create the individual follower
        const follower = await storage.createAiFollower(req.user!.id, {
          name: followerName,
          personality,
          avatarUrl: avatarUrl,
          background: followerBackground.background,
          interests: followerBackground.interests,
          communicationStyle: followerBackground.communication_style,
          interactionPreferences: followerBackground.interaction_preferences,
          responsiveness: selectedResponsiveness,
          responseDelay: responseDelay 
            ? responseDelay 
            : getDefaultDelay(selectedResponsiveness),
          responseChance: responseChance || 80,
          active: true,
          tools: null,
        });
        
        // Add this follower to the collective
        const membership = await storage.addFollowerToCollective(collective.id, follower.id);
        console.log(`[API] Added follower ${follower.id} to collective ${collective.id} with membership ${membership.id}`);
        
        createdFollowers.push(follower);
      }

      res.status(201).json({ 
        message: `Successfully created ${count} followers in collective '${collectiveName}'`,
        collective: collective,
        followers: createdFollowers
      });
    } catch (error) {
      console.error("Error creating AI collective:", error);
      res.status(500).json({ message: "Failed to create AI collective" });
    }
  });
  
  // Clone Factory API endpoint
  app.post("/api/followers/clone", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const userId = req.user!.id;
      const {
        templateFollowerId,
        collectiveName,
        description,
        cloneCount,
        variationLevel,
        customInstructions,
        namingOption = 'sequential', // default to sequential naming
        generateDynamicAvatars = false // default to false
      } = req.body;
      
      // Validate request
      if (!templateFollowerId) {
        return res.status(400).json({ message: "Template follower ID is required" });
      }
      
      if (!collectiveName) {
        return res.status(400).json({ message: "Collective name is required" });
      }
      
      if (cloneCount < 1 || cloneCount > 20) {
        return res.status(400).json({ message: "Clone count must be between 1 and 20" });
      }
      
      if (variationLevel < 0.1 || variationLevel > 1) {
        return res.status(400).json({ message: "Variation level must be between 0.1 and 1" });
      }
      
      console.log(`[API] Starting clone process for follower ID: ${templateFollowerId}`);
      
      // Execute clone process
      const result = await cloneFollowers(userId, {
        templateFollowerId,
        collectiveName,
        description: description || "",
        cloneCount,
        variationLevel,
        customInstructions: customInstructions || "",
        namingOption,
        generateDynamicAvatars
      });
      
      console.log(`[API] Clone process completed, created ${result.followers.length} clones`);
      
      res.status(201).json({
        message: `Successfully cloned follower into ${result.followers.length} new followers`,
        collectiveId: result.collectiveId,
        followers: result.followers
      });
    } catch (error) {
      console.error("Error in clone factory:", error);
      res.status(500).json({ 
        message: "Failed to clone followers",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
  
  // Get user's AI collectives
  app.get("/api/followers/collectives", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const collectives = await storage.getUserAiFollowerCollectives(req.user!.id);
      res.json(collectives);
    } catch (error) {
      console.error("Error getting AI collectives:", error);
      res.status(500).json({ message: "Failed to get AI collectives" });
    }
  });
  
  // Get a specific collective with its members
  app.get("/api/followers/collectives/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    const collectiveId = parseInt(req.params.id);
    if (isNaN(collectiveId)) {
      return res.status(400).json({ message: "Invalid collective ID" });
    }
    
    try {
      // First verify the collective belongs to the user
      const collective = await storage.getAiFollowerCollective(collectiveId);
      if (!collective || collective.userId !== req.user!.id) {
        return res.status(404).json({ message: "Collective not found" });
      }
      
      // Get the members of the collective
      const members = await storage.getCollectiveMembers(collectiveId);
      
      res.json({
        collective,
        members
      });
    } catch (error) {
      console.error("Error getting AI collective:", error);
      res.status(500).json({ message: "Failed to get AI collective" });
    }
  });
  
  // Get members of a collective (dedicated endpoint for just the members)
  app.get("/api/followers/collectives/:id/members", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    const collectiveId = parseInt(req.params.id);
    if (isNaN(collectiveId)) {
      return res.status(400).json({ message: "Invalid collective ID" });
    }
    
    try {
      // First verify the collective belongs to the user
      const collective = await storage.getAiFollowerCollective(collectiveId);
      if (!collective || collective.userId !== req.user!.id) {
        return res.status(404).json({ message: "Collective not found" });
      }
      
      // Get just the members array
      const members = await storage.getCollectiveMembers(collectiveId);
      console.log(`[Storage] Retrieved ${members.length} members for collective ${collectiveId}`);
      
      // Return just the members array
      res.json(members);
    } catch (error) {
      console.error(`Error getting AI collective members for ${collectiveId}:`, error);
      res.status(500).json({ message: "Failed to get AI collective members" });
    }
  });

  // Helper function to get a random item from an array
  function getRandomItem<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }

  // Helper function to get default delay based on responsiveness
  function getDefaultDelay(responsiveness: string = "active") {
    switch (responsiveness) {
      case "instant":
        return { min: 0, max: 5 };
      case "active":
        return { min: 5, max: 60 };
      case "casual":
        return { min: 60, max: 480 }; // 1-8 hours
      case "zen":
        return { min: 480, max: 1440 }; // 8-24 hours
      default:
        return { min: 5, max: 60 };
    }
  }

  app.get("/api/followers", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const followers = await storage.getAiFollowers(req.user!.id);
    res.json(followers);
  });
  
  // Get a single AI follower by ID
  app.get("/api/followers/:id", async (req, res) => {
    console.log(`[API] GET /api/followers/:id - Request received for ID: ${req.params.id}`);
    console.log(`[API] Authentication status: ${req.isAuthenticated()}`);
    
    if (!req.isAuthenticated()) {
      console.log(`[API] Request rejected: User not authenticated`);
      return res.sendStatus(401);
    }
    
    const followerId = parseInt(req.params.id);
    console.log(`[API] Parsed follower ID: ${followerId}, isNaN: ${isNaN(followerId)}`);
    
    if (isNaN(followerId)) {
      console.log(`[API] Request rejected: Invalid follower ID format`);
      return res.status(400).json({ message: "Invalid follower ID" });
    }
    
    try {
      console.log(`[API] Looking up follower with ID: ${followerId} for user: ${req.user!.id}`);
      
      // First verify the follower belongs to the user
      const follower = await storage.getAiFollower(followerId);
      console.log(`[API] Follower lookup result:`, follower ? 
        `Found (userId: ${follower.userId}, name: ${follower.name})` : 
        `Not found`);
      
      if (!follower) {
        console.log(`[API] Request rejected: Follower not found`);
        return res.status(404).json({ message: "Follower not found" });
      }
      
      if (follower.userId !== req.user!.id) {
        console.log(`[API] Request rejected: Follower belongs to different user (${follower.userId})`);
        return res.status(404).json({ message: "Follower not found" });
      }
      
      console.log(`[API] Sending successful response for follower: ${follower.name}`);
      res.json(follower);
    } catch (error) {
      console.error("[API] Error getting AI follower:", error);
      res.status(500).json({ message: "Failed to get AI follower" });
    }
  });

  app.patch("/api/followers/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const followerId = parseInt(req.params.id);
    
    console.log(`[API] PATCH /api/followers/:id - Request received for ID: ${followerId}`);
    console.log(`[API] Request body:`, req.body);

    try {
      // First verify the follower belongs to the user
      const follower = await storage.getAiFollower(followerId);
      if (!follower || follower.userId !== req.user!.id) {
        console.log(`[API] Update rejected: Follower not found or belongs to different user`);
        return res.status(404).json({ message: "Follower not found" });
      }

      // Check if this is Tom (default follower)
      const isDefaultTom = follower.id === 1 || follower.name.toLowerCase().includes('tom');
      console.log(`[API] Is default Tom follower: ${isDefaultTom}`);
      
      // Create update object with basic fields
      const updateData: Partial<Pick<AiFollower, "name" | "personality" | "responsiveness" | "background" | "communicationStyle" | "tools">> = {
        name: req.body.name,
        personality: req.body.personality,
        responsiveness: req.body.responsiveness,
      };
      
      // Add extended fields if not the default Tom follower
      if (!isDefaultTom) {
        console.log(`[API] Processing extended fields for non-Tom follower`);
        
        // Add optional fields
        if (req.body.background !== undefined) {
          updateData.background = req.body.background;
        }
        
        if (req.body.communicationStyle !== undefined) {
          updateData.communicationStyle = req.body.communicationStyle;
        }
        
        // If we have tools, add them
        if (req.body.tools !== undefined) {
          updateData.tools = req.body.tools;
          console.log(`[API] Updated tools: ${JSON.stringify(req.body.tools)}`);
        }
        
        // If we have interests, parse and add them
        if (req.body.interests !== undefined) {
          await storage.updateFollowerInterests(followerId, req.body.interests);
          console.log(`[API] Updated interests: ${JSON.stringify(req.body.interests)}`);
        }
        
        // If we have interaction preferences, parse and add them
        if (req.body.interactionPreferences !== undefined) {
          await storage.updateFollowerInteractionPreferences(
            followerId, 
            req.body.interactionPreferences.likes || [],
            req.body.interactionPreferences.dislikes || []
          );
          console.log(`[API] Updated interaction preferences`);
        }
      }

      // Update the follower with the basic fields
      console.log(`[API] Updating follower with data:`, updateData);
      const updatedFollower = await storage.updateAiFollower(followerId, updateData);

      console.log(`[API] Follower updated successfully`);
      res.json(updatedFollower);
    } catch (error) {
      console.error("[API] Error updating AI follower:", error);
      res.status(500).json({ message: "Failed to update AI follower" });
    }
  });

  app.delete("/api/followers/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const followerId = parseInt(req.params.id);

    try {
      // First verify the follower belongs to the user
      const follower = await storage.getAiFollower(followerId);
      if (!follower || follower.userId !== req.user!.id) {
        return res.status(404).json({ message: "Follower not found" });
      }

      // Toggle activation status
      const updatedFollower = follower.active
        ? await storage.deactivateAiFollower(followerId)
        : await storage.reactivateAiFollower(followerId);

      res.json(updatedFollower);
    } catch (error) {
      console.error("Error updating AI follower status:", error);
      res.status(500).json({ message: "Failed to update AI follower status" });
    }
  });

  // Direct Chat Endpoints
  app.get("/api/direct-chat/:followerId", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    const followerId = parseInt(req.params.followerId);
    const userId = req.user!.id;
    
    try {
      // First verify the follower belongs to the user
      const follower = await storage.getAiFollower(followerId);
      if (!follower || follower.userId !== userId) {
        return res.status(404).json({ message: "Follower not found" });
      }
      
      // Get chat history
      const chatHistory = await storage.getDirectChatHistory(userId, followerId);
      res.json(chatHistory);
    } catch (error) {
      console.error("Error getting direct chat history:", error);
      res.status(500).json({ message: "Failed to get chat history" });
    }
  });
  
  app.post("/api/direct-chat/:followerId", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    const followerId = parseInt(req.params.followerId);
    const userId = req.user!.id;
    const { message } = req.body;
    
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ message: "Message cannot be empty" });
    }
    
    try {
      // First verify the follower belongs to the user
      const follower = await storage.getAiFollower(followerId);
      if (!follower || follower.userId !== userId) {
        return res.status(404).json({ message: "Follower not found" });
      }
      
      // Create user message
      const userMessage = await storage.createDirectChatMessage({
        userId,
        aiFollowerId: followerId,
        content: message,
        isUserMessage: true
      });
      
      // Generate AI response immediately (overriding normal responsiveness)
      const response = await generateAIResponse(message, follower);
      
      // Parse the response
      let content = "";
      if (response && typeof response === "object") {
        if ("content" in response && response.content) {
          content = response.content;
        }
      } else if (typeof response === "string") {
        content = response;
      }
      
      // Create AI response
      const aiMessage = await storage.createDirectChatMessage({
        userId,
        aiFollowerId: followerId,
        content,
        isUserMessage: false
      });
      
      // Return both messages
      res.json([userMessage, aiMessage]);
    } catch (error) {
      console.error("Error in direct chat:", error);
      res.status(500).json({ message: "Failed to process chat message" });
    }
  });

  // Add endpoint to get circle details including members and followers
  app.get("/api/circles/:id/details", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    try {
      // Check if user has access to this circle
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage);
      if (!hasPermission) {
        return res.status(403).json({ message: "Access denied" });
      }

      const details = await storage.getCircleWithDetails(circleId);
      if (!details) {
        return res.status(404).json({ message: "Circle not found" });
      }

      res.json(details);
    } catch (error) {
      console.error("Error getting circle details:", error);
      res.status(500).json({ message: "Failed to get circle details" });
    }
  });

  // Deactivate a circle member
  app.post("/api/circles/:id/members/:userId/deactivate", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    const targetUserId = parseInt(req.params.userId);

    try {
      // Check if user has permission to manage members
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage, "owner");
      if (!hasPermission) {
        return res.status(403).json({ message: "Only circle owners can deactivate members" });
      }

      // Can't deactivate the owner
      const circle = await storage.getCircle(circleId);
      if (circle?.userId === targetUserId) {
        return res.status(400).json({ message: "Cannot deactivate the circle owner" });
      }

      await storage.deactivateCircleMember(circleId, targetUserId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error deactivating circle member:", error);
      res.status(500).json({ message: "Failed to deactivate circle member" });
    }
  });

  // Reactivate a circle member
  app.post("/api/circles/:id/members/:userId/reactivate", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    const circleId = parseInt(req.params.id);
    const targetUserId = parseInt(req.params.userId);

    try {
      // Check if user has permission to manage members
      const hasPermission = await hasCirclePermission(circleId, req.user!.id, storage, "owner");
      if (!hasPermission) {
        return res.status(403).json({ message: "Only circle owners can reactivate members" });
      }

      await storage.reactivateCircleMember(circleId, targetUserId);
      res.sendStatus(200);
    } catch (error) {
      console.error("Error reactivating circle member:", error);
      res.status(500).json({ message: "Failed to reactivate circle member" });
    }
  });

  // Get deactivated circles
  app.get("/api/circles/deactivated", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const circles = await storage.getDeactivatedCircles(req.user!.id);
      res.json(circles);
    } catch (error) {
      console.error("Error getting deactivated circles:", error);
      res.status(500).json({ message: "Failed to get deactivated circles" });
    }
  });

  // ======= Labs API Routes =======
  
  // Get all user's labs
  app.get("/api/labs", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);

    try {
      const labs = await storage.getUserLabs(req.user!.id);
      res.json(labs);
    } catch (error) {
      console.error("Error getting user labs:", error);
      res.status(500).json({ message: "Failed to get labs" });
    }
  });

  // Get a specific lab
  app.get("/api/labs/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to view this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to view this lab" });
      }
      
      // Get associated circles and lab posts
      const circles = await storage.getLabCircles(labId);
      const posts = await storage.getLabPosts(labId);
      
      // Return the lab with the associated data
      res.json({
        ...lab,
        circles,
        posts
      });
    } catch (error) {
      console.error("Error getting lab:", error);
      res.status(500).json({ message: "Failed to get lab" });
    }
  });
  
  // Get circles for a specific lab
  app.get("/api/labs/:id/circles", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to view this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to view this lab" });
      }
      
      const circles = await storage.getLabCircles(labId);
      res.json(circles);
    } catch (error) {
      console.error("Error getting lab circles:", error);
      res.status(500).json({ message: "Failed to get lab circles" });
    }
  });
  
  // Add a circle to a lab
  app.post("/api/labs/:id/circles", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const { circleId } = req.body;
      
      if (!circleId) {
        return res.status(400).json({ message: "Circle ID is required" });
      }
      
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to modify this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to modify this lab" });
      }
      
      // Add the circle to the lab
      const labCircle = await storage.addCircleToLab(labId, circleId);
      res.status(201).json(labCircle);
    } catch (error) {
      console.error("Error adding circle to lab:", error);
      res.status(500).json({ message: "Failed to add circle to lab" });
    }
  });
  
  // Remove a circle from a lab
  app.delete("/api/labs/:labId/circles/:circleId", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.labId);
      const circleId = parseInt(req.params.circleId);
      
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to modify this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to modify this lab" });
      }
      
      // Remove the circle from the lab
      await storage.removeCircleFromLab(labId, circleId);
      res.sendStatus(204);
    } catch (error) {
      console.error("Error removing circle from lab:", error);
      res.status(500).json({ message: "Failed to remove circle from lab" });
    }
  });

  // Create a new lab
  app.post("/api/labs", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const { name, description, circleId, status } = req.body;
      
      // Basic validation
      if (!name || !circleId) {
        return res.status(400).json({ message: "Name and circle ID are required" });
      }
      
      // Create the lab
      const lab = await storage.createLab(req.user!.id, {
        name,
        description,
        circleId, // Keep for backward compatibility
        status: status || "draft"
      });
      
      // Add the circle to the lab (many-to-many relationship)
      await storage.addCircleToLab(lab.id, circleId);
      
      res.status(201).json(lab);
    } catch (error) {
      console.error("Error creating lab:", error);
      res.status(500).json({ message: "Failed to create lab" });
    }
  });

  // Update a lab
  app.put("/api/labs/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to update this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to update this lab" });
      }
      
      const { name, description, circleId, status } = req.body;
      
      // If circleId is provided and it's different from the current primary circle
      if (circleId && lab.circleId !== circleId) {
        // Add the new circle to the lab's circles (if it doesn't exist already)
        try {
          // First check if this circle is already associated with the lab
          const labCircles = await storage.getLabCircles(labId);
          const circleExists = labCircles.some(c => c.id === circleId);
          
          if (!circleExists) {
            await storage.addCircleToLab(labId, circleId);
          }
        } catch (err) {
          console.error("Error updating lab-circle relationship:", err);
        }
      }
      
      // Update the lab
      const updatedLab = await storage.updateLab(labId, {
        name,
        description,
        circleId, // Update the primary circle
        status
      });
      
      res.json(updatedLab);
    } catch (error) {
      console.error("Error updating lab:", error);
      res.status(500).json({ message: "Failed to update lab" });
    }
  });

  // Delete a lab
  app.delete("/api/labs/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to delete this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to delete this lab" });
      }
      
      // Delete the lab
      await storage.deleteLab(labId);
      
      res.sendStatus(204);
    } catch (error) {
      console.error("Error deleting lab:", error);
      res.status(500).json({ message: "Failed to delete lab" });
    }
  });

  // Get lab posts
  app.get("/api/labs/:id/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to view this lab's posts
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to view this lab's posts" });
      }
      
      const posts = await storage.getLabPosts(labId);
      res.json(posts);
    } catch (error) {
      console.error("Error getting lab posts:", error);
      res.status(500).json({ message: "Failed to get lab posts" });
    }
  });

  // Create a lab post
  app.post("/api/labs/:id/posts", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const labId = parseInt(req.params.id);
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      // Check if the user has permission to add posts to this lab
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to add posts to this lab" });
      }
      
      const { content, postOrder, scheduledFor } = req.body;
      
      // Basic validation
      if (!content) {
        return res.status(400).json({ message: "Content is required" });
      }
      
      // Count existing posts for this lab to determine post order if not provided
      const existingPosts = await storage.getLabPosts(labId);
      const nextOrder = postOrder || existingPosts.length + 1;
      
      // Create the lab post
      const post = await storage.createLabPost({
        labId,
        content,
        postOrder: nextOrder,
        status: "pending",
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined
      });
      
      res.status(201).json(post);
    } catch (error) {
      console.error("Error creating lab post:", error);
      res.status(500).json({ message: "Failed to create lab post" });
    }
  });

  // Update a lab post
  app.put("/api/labs/posts/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const postId = parseInt(req.params.id);
      const { content, postOrder, status, scheduledFor } = req.body;
      
      // Get the post to verify ownership through the lab
      const posts = await storage.getLabPosts(parseInt(req.body.labId));
      const post = posts.find(p => p.id === postId);
      
      if (!post) {
        return res.status(404).json({ message: "Lab post not found" });
      }
      
      // Get the lab to verify ownership
      const lab = await storage.getLab(post.labId);
      
      if (!lab || lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to update this post" });
      }
      
      // Update the lab post
      const updatedPost = await storage.updateLabPost(postId, {
        content,
        postOrder,
        status,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined
      });
      
      res.json(updatedPost);
    } catch (error) {
      console.error("Error updating lab post:", error);
      res.status(500).json({ message: "Failed to update lab post" });
    }
  });

  // Delete a lab post
  app.delete("/api/labs/posts/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    
    try {
      const postId = parseInt(req.params.id);
      const labId = parseInt(req.query.labId as string);
      
      if (!labId) {
        return res.status(400).json({ message: "Lab ID is required" });
      }
      
      // Get the lab to verify ownership
      const lab = await storage.getLab(labId);
      
      if (!lab) {
        return res.status(404).json({ message: "Lab not found" });
      }
      
      if (lab.userId !== req.user!.id) {
        return res.status(403).json({ message: "You don't have permission to delete this post" });
      }
      
      // Delete the lab post
      await storage.deleteLabPost(postId);
      
      res.sendStatus(204);
    } catch (error) {
      console.error("Error deleting lab post:", error);
      res.status(500).json({ message: "Failed to delete lab post" });
    }
  });

  // Register NFT blockchain routes
  app.use("/api/nft", nftRoutes);
  console.log("[API] NFT routes registered");

  return httpServer;
}