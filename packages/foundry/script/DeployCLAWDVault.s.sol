// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DeployHelpers.s.sol";
import { CLAWDVault } from "../contracts/CLAWDVault.sol";

/**
 * @notice Deploy script for the CLAWDVault contract.
 *
 * @dev Deployer-first pattern: the constructor takes the owner directly, so the
 *      client wallet becomes the owner in a single transaction - no Ownable2Step
 *      handoff or ownership transfer required.
 *
 * Example:
 *   yarn deploy --file DeployCLAWDVault.s.sol --network base
 */
contract DeployCLAWDVault is ScaffoldETHDeploy {
    /// @notice Final owner of the deployed vault (client wallet on Base).
    address public constant CLIENT_OWNER = 0x9F01F827C339D6a623968b68903DB5C4e26DBF55;

    function run() external ScaffoldEthDeployerRunner {
        CLAWDVault vault = new CLAWDVault(CLIENT_OWNER);

        deployments.push(Deployment({ name: "CLAWDVault", addr: address(vault) }));
    }
}
