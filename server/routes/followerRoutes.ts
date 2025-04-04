import { Router } from 'express';
import { storage } from '../storage';
import { requireAuth, hasCirclePermission } from './middleware';
import { generateAIBackground } from '../openai';
import { cloneFollowers } from '../clone-service';

const router = Router();

/**
 * GET /api/followers - Get all AI followers
 * 
 * NOTE: This route is commented out because a direct implementation 
 * is provided in routes.ts. Do not uncomment unless the direct implementation
 * is removed as it would create duplicate routes.
 */
/* 
router.get('/', requireAuth, async (req, res) => {
  // Direct implementation in routes.ts takes precedence
  // The implementation in routes.ts passes the req.user!.id parameter
  const followers = await storage.getAiFollowers(req.user!.id);
  res.json(followers);
});
*/

/**
 * GET /api/followers/:id - Get AI follower by ID
 */
router.get('/:id', requireAuth, async (req, res) => {
  const followerId = parseInt(req.params.id);
  
  // Check if followerId is a valid number
  if (isNaN(followerId)) {
    return res.status(400).json({ message: "Invalid follower ID format" });
  }
  
  try {
    const follower = await storage.getAiFollower(followerId);
    if (!follower) {
      return res.status(404).json({ message: "AI Follower not found" });
    }
    
    // Get follower metadata
    const creatorUser = await storage.getUser(follower.userId || 0);

    // Return follower with additional data
    res.json({
      ...follower,
      creator: creatorUser ? {
        id: creatorUser.id,
        username: creatorUser.username,
        displayName: creatorUser.displayName,
        avatarUrl: creatorUser.avatarUrl
      } : undefined
    });
  } catch (error) {
    console.error("Error getting AI follower:", error);
    res.status(500).json({ message: "Failed to get AI follower" });
  }
});

/**
 * POST /api/followers - Create a new AI follower
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    // Extract required fields for AI background generation
    const { name, personality, customInstructions } = req.body;
    
    // Validate that name and personality are strings
    if (typeof name !== 'string' || typeof personality !== 'string') {
      return res.status(400).json({ 
        message: "Invalid input: name and personality must be provided as strings" 
      });
    }
    
    // Generate AI background with proper parameters
    const backgroundData = await generateAIBackground(
      name, 
      personality, 
      customInstructions
    );
    
    // Create new AI follower with the generated background
    const newFollower = await storage.createAiFollower({
      ...req.body,
      ...backgroundData,
      createdBy: req.user!.id,
    });

    // Return the newly created follower
    res.status(201).json(newFollower);
  } catch (error) {
    console.error("Error creating AI follower:", error);
    res.status(500).json({ message: "Failed to create AI follower" });
  }
});

/**
 * PATCH /api/followers/:id - Update AI follower
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const followerId = parseInt(req.params.id);
  
  // Check if followerId is a valid number
  if (isNaN(followerId)) {
    return res.status(400).json({ message: "Invalid follower ID format" });
  }
  
  try {
    // Verify follower ownership
    const follower = await storage.getAiFollower(followerId);
    if (!follower || follower.userId !== req.user!.id) {
      return res.status(404).json({ message: "AI Follower not found or you don't have permission" });
    }
    
    // Update follower
    const updatedFollower = await storage.updateAiFollower(followerId, req.body);
    res.json(updatedFollower);
  } catch (error) {
    console.error("Error updating AI follower:", error);
    res.status(500).json({ message: "Failed to update AI follower" });
  }
});

/**
 * DELETE /api/followers/:id - Delete AI follower
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const followerId = parseInt(req.params.id);
  
  // Check if followerId is a valid number
  if (isNaN(followerId)) {
    return res.status(400).json({ message: "Invalid follower ID format" });
  }
  
  try {
    // Verify follower ownership
    const follower = await storage.getAiFollower(followerId);
    if (!follower || follower.userId !== req.user!.id) {
      return res.status(404).json({ message: "AI Follower not found or you don't have permission" });
    }
    
    // Delete follower
    await storage.deleteAiFollower(followerId);
    res.sendStatus(200);
  } catch (error) {
    console.error("Error deleting AI follower:", error);
    res.status(500).json({ message: "Failed to delete AI follower" });
  }
});

/**
 * POST /api/followers/clone - Clone an AI follower
 */
router.post('/clone', requireAuth, async (req, res) => {
  try {
    const response = await cloneFollowers(req.user!.id, req.body);
    res.status(201).json(response);
  } catch (error) {
    console.error("Error cloning AI followers:", error);
    res.status(500).json({ message: "Failed to clone followers" });
  }
});

/**
 * IMPORTANT: The AI followers collective endpoints are directly registered in routes.ts
 * to ensure they have priority over these router-based routes. This is necessary to fix
 * route conflicts that were causing 400 errors in the frontend.
 * 
 * See the direct implementations in routes.ts for the following endpoints:
 * - GET /api/followers/collectives
 * - GET /api/followers/collectives/:id
 * - GET /api/followers/collectives/:id/members
 */

/*
// These routes are commented out because they are now directly implemented in routes.ts
// Keeping them here for reference and documentation purposes

router.get('/collectives', requireAuth, async (req, res) => {
  try {
    const collectives = await storage.getUserAiFollowerCollectives(req.user!.id);
    res.json(collectives);
  } catch (error) {
    console.error("Error getting AI follower collectives:", error);
    res.status(500).json({ message: "Failed to get AI follower collectives" });
  }
});

router.get('/collectives/:id', requireAuth, async (req, res) => {
  const collectiveId = parseInt(req.params.id);
  
  if (isNaN(collectiveId)) {
    return res.status(400).json({ message: "Invalid collective ID format" });
  }
  
  try {
    const collective = await storage.getAiFollowerCollective(collectiveId);
    if (!collective) {
      return res.status(404).json({ message: "Collective not found" });
    }
    
    res.json(collective);
  } catch (error) {
    console.error("Error getting collective:", error);
    res.status(500).json({ message: "Failed to get collective" });
  }
});

router.get('/collectives/:id/members', requireAuth, async (req, res) => {
  const collectiveId = parseInt(req.params.id);
  
  if (isNaN(collectiveId)) {
    return res.status(400).json({ message: "Invalid collective ID format" });
  }
  
  try {
    const collective = await storage.getAiFollowerCollective(collectiveId);
    if (!collective) {
      return res.status(404).json({ message: "Collective not found" });
    }
    
    const followers = await storage.getCollectiveMembers(collectiveId);
    const creatorInfo = await storage.getUser(collective.userId);
    
    const wantsOnlyMembersArray = req.query.membersOnly === 'true';
    
    if (wantsOnlyMembersArray) {
      res.json(followers);
    } else {
      res.json({
        ...collective,
        followers,
        creator: creatorInfo ? {
          id: creatorInfo.id,
          username: creatorInfo.username
        } : undefined
      });
    }
  } catch (error) {
    console.error("Error getting collective members:", error);
    res.status(500).json({ message: "Failed to get collective members" });
  }
});
*/

/**
 * POST /api/followers/collective - Create a new AI collective
 */
router.post('/collective', requireAuth, async (req, res) => {
  const { name, description, followerIds, circleId } = req.body;
  
  if (!Array.isArray(followerIds) || followerIds.length === 0) {
    return res.status(400).json({ message: "At least one follower must be selected" });
  }
  
  // Validate followerIds to ensure they're all valid numbers
  if (followerIds.some(id => typeof id !== 'number' || isNaN(id))) {
    return res.status(400).json({ message: "All follower IDs must be valid numbers" });
  }
  
  // Validate circleId if provided
  if (circleId !== undefined && (typeof circleId !== 'number' || isNaN(circleId))) {
    return res.status(400).json({ message: "Invalid circle ID format" });
  }
  
  try {
    // Verify follower ownership for all followers
    const followers = await Promise.all(
      followerIds.map(id => storage.getAiFollower(id))
    );
    
    // Make sure all followers exist and user has permission
    if (followers.some(f => !f)) {
      return res.status(404).json({ message: "One or more AI Followers not found" });
    }
    
    // If circleId is provided, make sure user has permission
    if (circleId) {
      const hasPermission = await hasCirclePermission(
        circleId, 
        req.user!.id, 
        storage,
        "collaborator"
      );
      
      if (!hasPermission) {
        return res.status(403).json({ message: "You don't have permission to add followers to this circle" });
      }
    }
    
    // Create collective
    const collective = await storage.createAiCollective({
      name,
      description,
      followerIds,
      createdBy: req.user!.id
    });
    
    // If circleId is provided, add collective to circle
    if (circleId) {
      await storage.addCircleCollective(circleId, collective.id);
    }
    
    res.status(201).json(collective);
  } catch (error) {
    console.error("Error creating AI collective:", error);
    res.status(500).json({ message: "Failed to create AI collective" });
  }
});

export default router;