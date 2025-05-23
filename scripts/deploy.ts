import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  const usdcAddress = process.env.USDC_ADDRESS;
  const platformWallet = process.env.PLATFORM_WALLET;

  if (!usdcAddress || !platformWallet) {
    throw new Error("Missing required environment variables");
  }

  const TwoPay = await ethers.getContractFactory("TwoPay");
  const twoPay = await TwoPay.deploy(usdcAddress, platformWallet);

  await twoPay.waitForDeployment();

  console.log("TwoPay deployed to:", await twoPay.getAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 