import { AiFollower, AiInteraction, PendingResponse } from "@shared/schema";
import { storage } from "./storage";

// Define a simplified pending response type for UI display
interface DisplayPendingResponse {
  id: number;
  name: string;
  avatarUrl: string;
  scheduledFor: Date;
}

export interface ThreadedInteraction extends AiInteraction {
  aiFollower?: AiFollower;
  replies: ThreadedInteraction[];
  pendingResponses?: DisplayPendingResponse[];
}

export class ThreadManager {
  /**
   * Fetches all interactions for a post and organizes them into a threaded structure
   */
  static async getThreadedInteractions(postId: number): Promise<ThreadedInteraction[]> {
    // Get all interactions for the post
    const interactions = await storage.getPostInteractions(postId);
    console.log(`[ThreadManager] Processing ${interactions.length} interactions for post ${postId}`);

    // Get all pending responses for the post
    const allPendingResponses = await storage.getPostPendingResponses(postId);
    console.log(`[ThreadManager] Found ${allPendingResponses.length} pending responses for post ${postId}`);

    // Create a map to store interactions by their ID for quick lookup
    const interactionMap = new Map<number, ThreadedInteraction>();

    // First pass: create base interaction objects with their AI follower info
    await Promise.all(
      interactions.map(async (interaction) => {
        const follower = interaction.aiFollowerId ? 
          await storage.getAiFollower(interaction.aiFollowerId) 
          : undefined;

        // Filter pending responses for this interaction
        const interactionPendingResponses = allPendingResponses.filter(
          response => {
            if (!response.metadata) return false;
            try {
              const metadata = JSON.parse(response.metadata);
              return metadata.parentId === interaction.id;
            } catch (e) {
              return false;
            }
          }
        )
        
        // Get follower info for each pending response and format them
        const formattedPendingResponses = await Promise.all(
          interactionPendingResponses.map(async pr => {
            // Get follower info to display name and avatar 
            let followerName = "AI";
            let followerAvatarUrl = "";
            
            if (pr.aiFollowerId) {
              const follower = await storage.getAiFollower(pr.aiFollowerId);
              if (follower) {
                followerName = follower.name;
                followerAvatarUrl = follower.avatarUrl;
              }
            }
            
            return {
              id: pr.id,
              name: followerName,
              avatarUrl: followerAvatarUrl,
              scheduledFor: pr.scheduledFor
            };
          })
        );
        
        // Create the base interaction object with explicit type casting
        const threadedInteraction: ThreadedInteraction = {
          ...interaction,
          aiFollower: follower,
          replies: [],
          pendingResponses: formattedPendingResponses.length > 0 ? formattedPendingResponses : undefined
        };

        interactionMap.set(interaction.id, threadedInteraction);

        console.log(`[ThreadManager] Created base interaction ${interaction.id}:`, {
          type: interaction.type,
          parentId: interaction.parentId,
          hasFollower: !!follower,
          pendingResponses: formattedPendingResponses.length,
          content: interaction.content?.substring(0, 50)
        });
      })
    );

    // Second pass: build the thread hierarchy
    const rootInteractions: ThreadedInteraction[] = [];

    // Helper function to recursively build thread hierarchy
    function buildThreadHierarchy(parentId: number | null): ThreadedInteraction[] {
      const children = interactions
        .filter(interaction => interaction.parentId === parentId)
        .map(interaction => {
          const thread = interactionMap.get(interaction.id);
          if (!thread) {
            console.error(`[ThreadManager] Missing interaction ${interaction.id} in map`);
            return null;
          }

          // Recursively get and set child replies
          const childReplies = buildThreadHierarchy(interaction.id);
          thread.replies = childReplies;

          console.log(`[ThreadManager] Built thread ${interaction.id}:`, {
            type: interaction.type,
            replyCount: childReplies.length,
            content: interaction.content?.substring(0, 50)
          });

          return thread;
        })
        .filter((thread): thread is ThreadedInteraction => thread !== null)
        .sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return aTime - bTime;
        });

      return children;
    }

    // Get root level interactions and build their hierarchies
    const rootLevelInteractions = interactions.filter(interaction => interaction.parentId === null);
    rootLevelInteractions.forEach(rootInteraction => {
      const thread = interactionMap.get(rootInteraction.id);
      if (!thread) {
        console.error(`[ThreadManager] Missing root interaction ${rootInteraction.id} in map`);
        return;
      }

      thread.replies = buildThreadHierarchy(rootInteraction.id);
      rootInteractions.push(thread);

      console.log(`[ThreadManager] Added root thread ${rootInteraction.id}:`, {
        type: rootInteraction.type,
        replyCount: thread.replies.length,
        content: rootInteraction.content?.substring(0, 50)
      });
    });

    // Sort root interactions by creation time
    rootInteractions.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });

    console.log(`[ThreadManager] Final thread structure for post ${postId}:`, 
      rootInteractions.map(interaction => ({
        id: interaction.id,
        type: interaction.type,
        replyCount: interaction.replies.length,
        totalReplies: this.countTotalReplies(interaction),
        hasContent: !!interaction.content
      }))
    );

    return rootInteractions;
  }

  /**
   * Recursively counts total number of replies in a thread, including nested replies
   */
  private static countTotalReplies(thread: ThreadedInteraction): number {
    let count = thread.replies.length;
    for (const reply of thread.replies) {
      count += this.countTotalReplies(reply);
    }
    return count;
  }

  /**
   * Recursively finds a specific thread and all its replies in the thread hierarchy
   */
  static findThreadById(threads: ThreadedInteraction[], targetId: number): ThreadedInteraction | null {
    for (const thread of threads) {
      if (thread.id === targetId) {
        return thread;
      }
      const found = this.findThreadById(thread.replies, targetId);
      if (found) return found;
    }
    return null;
  }
}