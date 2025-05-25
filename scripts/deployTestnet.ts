import { ethers } from "hardhat";

async function main() {
  // Replace with the actual USDC testnet address and your platform wallet address
  const usdcAddress = process.env.USDC_ADDRESS_SEPOLIA 
  const platformWallet = process.env.PLATFORM_WALLET 

  const TwoPayTestnet = await ethers.getContractFactory("TwoPayTestnet", {
    // This will use the TwoPay contract from TwoPayTestnet.sol
    // If you want to be explicit, you can use artifacts.require or pass the path
  });
  const twoPay = await TwoPayTestnet.deploy(usdcAddress, platformWallet);
  await twoPay.waitForDeployment();

  console.log("TwoPayTestnet deployed to:", await twoPay.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
