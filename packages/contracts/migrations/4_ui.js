const Poseidon3 = artifacts.require("Poseidon3");
const Poseidon4 = artifacts.require("Poseidon4");
const UserInteractable = artifacts.require("UserInteractable");

module.exports = function migration(deployer) {
  return deployer.then(async () => {
    await deployer.link(Poseidon3, UserInteractable);
    await deployer.link(Poseidon4, UserInteractable);
    await deployer.deploy(UserInteractable);
  });
};
