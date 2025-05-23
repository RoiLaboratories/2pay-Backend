# 2pay Backend

This is the backend service for the 2pay decentralized contribution platform. It handles contribution registration, pool management, and payout processing.

## Features

- Smart contract integration for contribution pools
- USDC payment processing
- Contribution tracking and verification
- Pool status monitoring
- Admin controls for manual payouts
- Secure wallet authentication
- Supabase database integration

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Hardhat
- Supabase account
- Base network access

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

4. Update the `.env` file with your configuration values

5. Deploy the smart contract:
   ```bash
   npx hardhat run scripts/deploy.ts --network base
   ```

6. Start the development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Contributions

- `POST /api/contribute`
  - Register a new contribution
  - Body: `{ tier: number, txHash: string }`

- `GET /api/contributions/:address`
  - Get user's contributions
  - Params: `address` (wallet address)

### Pools

- `GET /api/pools/:tier`
  - Get pool status
  - Params: `tier` (1, 2, or 3)

- `GET /api/pools/:tier/queue`
  - Get payout queue for a pool
  - Params: `tier` (1, 2, or 3)

### Admin

- `POST /api/admin/trigger-payout`
  - Trigger manual payout
  - Body: `{ tier: number }`
  - Requires admin authentication

## Database Schema

### Users Table
```sql
create table users (
  id uuid primary key default uuid_generate_v4(),
  wallet_address text unique not null,
  is_admin boolean default false,
  created_at timestamp with time zone default now()
);
```

### Contributions Table
```sql
create table contributions (
  id uuid primary key default uuid_generate_v4(),
  user_address text references users(wallet_address),
  tier integer not null,
  transaction_hash text unique not null,
  status text not null,
  created_at timestamp with time zone default now()
);
```

## Security

- JWT-based authentication
- Rate limiting
- Input validation
- Secure environment variables
- Contract interaction verification

## Deployment

The backend is designed to be deployed on Vercel or similar serverless platforms. Make sure to:

1. Set up all environment variables
2. Configure CORS for your frontend domain
3. Set up Supabase database
4. Deploy the smart contract to Base mainnet

## License

MIT 