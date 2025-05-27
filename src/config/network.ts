export interface NetworkConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
  chainId: number;
  networkName: string;
  adminPrivateKey: string;
}

export const getNetworkConfig = (): NetworkConfig => {
  const isTestnet = process.env.NETWORK === 'testnet';
  
  return {
    rpcUrl: isTestnet ? process.env.BASE_SEPOLIA_RPC_URL! : process.env.BASE_MAINNET_RPC_URL!,
    contractAddress: isTestnet ? process.env.TWO_PAY_TESTNET_ADDRESS! : process.env.TWO_PAY_MAINNET_ADDRESS!,
    usdcAddress: isTestnet ? process.env.USDC_TESTNET_ADDRESS! : process.env.USDC_MAINNET_ADDRESS!,
    adminPrivateKey: isTestnet ? process.env.TESTNET_ADMIN_PRIVATE_KEY! : process.env.MAINNET_ADMIN_PRIVATE_KEY!,
    chainId: isTestnet ? 84532 : 8453, // Base Sepolia: 84532, Base Mainnet: 8453
    networkName: isTestnet ? 'Base Sepolia' : 'Base Mainnet'
  };
};
