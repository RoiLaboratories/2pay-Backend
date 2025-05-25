// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TwoPayTestnet is Ownable, ReentrancyGuard {
    IERC20 public usdc;
    
    struct Pool {
        uint256 contributionAmount;
        uint256 currentBatch;
        address[] contributors;
        mapping(uint256 => address[]) batches;
        mapping(uint256 => uint256) batchPayoutIndex;
    }
    
    mapping(uint256 => Pool) public pools;
    // Track if an address has contributed to a specific tier
    mapping(address => mapping(uint256 => bool)) public hasContributed;
    address public platformWallet;
    
    event ContributionAdded(address indexed contributor, uint256 tier, uint256 batch);
    event PayoutProcessed(address indexed contributor, uint256 amount, uint256 tier, uint256 batch);
    
    constructor(address _usdcAddress, address _platformWallet) Ownable(msg.sender) {
        usdc = IERC20(_usdcAddress);
        platformWallet = _platformWallet;
        
        // Initialize pools
        pools[1].contributionAmount = 10 * 10**6; // $10 USDC (6 decimals)
        pools[2].contributionAmount = 50 * 10**6; // $50 USDC
        pools[3].contributionAmount = 500 * 10**6; // $500 USDC
    }
    
    function contribute(uint256 tier) external nonReentrant {
        require(tier >= 1 && tier <= 3, "Invalid tier");
        require(!hasContributed[msg.sender][tier], "Already contributed to this tier");
        
        Pool storage pool = pools[tier];
        
        // Transfer USDC from contributor
        require(
            usdc.transferFrom(msg.sender, address(this), pool.contributionAmount),
            "USDC transfer failed"
        );
        
        // Mark address as having contributed to this tier
        hasContributed[msg.sender][tier] = true;
        
        // Add contributor to current batch
        pool.contributors.push(msg.sender);
        
        // If batch is complete (5 contributors), process payout
        if (pool.contributors.length == 5) {
            _processBatchPayout(tier);
        }
        
        emit ContributionAdded(msg.sender, tier, pool.currentBatch);
    }
    
    function _processBatchPayout(uint256 tier) private {
        Pool storage pool = pools[tier];
        
        // Store current batch contributors
        pool.batches[pool.currentBatch] = pool.contributors;
        
        // If this is the first batch, process first payout immediately
        if (pool.currentBatch == 0) {
            address firstContributor = pool.batches[0][0];
            _processPayout(firstContributor, tier);
            pool.batchPayoutIndex[0] = 1;
        } else {
            // For subsequent batches, process next payout from previous batch
            uint256 previousBatch = pool.currentBatch - 1;
            uint256 payoutIndex = pool.batchPayoutIndex[previousBatch];
            
            if (payoutIndex < 5) {
                address nextContributor = pool.batches[previousBatch][payoutIndex];
                _processPayout(nextContributor, tier);
                pool.batchPayoutIndex[previousBatch]++;
            }
        }
        
        // Reset contributors array and increment batch
        delete pool.contributors;
        pool.currentBatch++;
    }
    
    function _processPayout(address contributor, uint256 tier) private {
        // Calculate amounts based on tier
        uint256 contributorAmount;
        uint256 platformAmount;
        
        if (tier == 1) { // $10 tier
            contributorAmount = 30 * 10**6; // $30
            platformAmount = 20 * 10**6;   // $20
        } else if (tier == 2) { // $50 tier
            contributorAmount = 150 * 10**6; // $150
            platformAmount = 100 * 10**6;   // $100
        } else { // $500 tier
            contributorAmount = 1500 * 10**6; // $1500
            platformAmount = 1000 * 10**6;   // $1000
        }
        
        // Transfer USDC
        require(
            usdc.transfer(contributor, contributorAmount),
            "Contributor payout failed"
        );
        require(
            usdc.transfer(platformWallet, platformAmount),
            "Platform payout failed"
        );
        
        emit PayoutProcessed(contributor, contributorAmount, tier, pools[tier].currentBatch);
    }
    
    function getPoolStatus(uint256 tier) external view returns (
        uint256 currentBatch,
        uint256 contributorsInBatch,
        uint256 nextPayoutIndex
    ) {
        Pool storage pool = pools[tier];
        return (
            pool.currentBatch,
            pool.contributors.length,
            pool.batchPayoutIndex[pool.currentBatch]
        );
    }
    
    function setPlatformWallet(address _platformWallet) external onlyOwner {
        platformWallet = _platformWallet;
    }
}
