import { Router, Request, Response } from 'express';
// import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
// import { supabase } from '../app';         // adjust import path as needed
import { logger } from '../config/logger'; // your logger, optional
import { verifyWalletSignature } from '../middleware/auth'; // your helper

const router = Router();

// Simple in-memory nonce storage for demo
const nonces = new Map<string, string>();

// POST /api/auth/nonce
router.post('/nonce', (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: 'Wallet address required' });
  }

  const nonce = `Login nonce: ${Math.floor(Math.random() * 1000000)}`;
  nonces.set(address.toLowerCase(), nonce);

  return res.json({ nonce });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { address, signature } = req.body;

  if (!address || !signature) {
    return res.status(400).json({ error: 'Address and signature are required' });
  }

  const nonce = nonces.get(address.toLowerCase());
  if (!nonce) {
    return res.status(400).json({ error: 'No nonce found for this address' });
  }

  try {
    // Verify signature using your helper or ethers.js directly
    const isValid = await verifyWalletSignature(address, signature, nonce);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Generate JWT token with wallet address only
    const token = jwt.sign(
      {
        address: address.toLowerCase(),
      },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // Remove nonce after successful login
    nonces.delete(address.toLowerCase());

    return res.json({ token });
  } catch (err) {
    logger.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
