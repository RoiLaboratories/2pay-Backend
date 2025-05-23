// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TwoPay is Ownable, ReentrancyGuard {
    IERC20 public usdc;
    
    struct Pool {
        uint256 contributionAmount;
        uint256 currentBatch;
        address[] contributors;
        mapping(uint256 => address[]) batches;
        mapping(uint256 => uint256) batchPayoutIndex;
    }
    
    mapping(uint256 => Pool) public pools;
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
        Pool storage pool = pools[tier];
        
        // Transfer USDC from contributor
        require(
            usdc.transferFrom(msg.sender, address(this), pool.contributionAmount),
            "USDC transfer failed"
        );
        
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
        
        // Process payout for the next contributor in queue
        uint256 payoutIndex = pool.batchPayoutIndex[pool.currentBatch];
        if (payoutIndex < 5) {
            address contributor = pool.batches[pool.currentBatch][payoutIndex];
            
            // Calculate amounts (60% to contributor, 40% to platform)
            uint256 contributorAmount = (pool.contributionAmount * 3) / 2; // $30
            uint256 platformAmount = pool.contributionAmount; // $20
            
            // Transfer USDC
            require(
                usdc.transfer(contributor, contributorAmount),
                "Contributor payout failed"
            );
            require(
                usdc.transfer(platformWallet, platformAmount),
                "Platform payout failed"
            );
            
            pool.batchPayoutIndex[pool.currentBatch]++;
            emit PayoutProcessed(contributor, contributorAmount, tier, pool.currentBatch);
        }
        
        // Reset contributors array and increment batch
        delete pool.contributors;
        pool.currentBatch++;
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