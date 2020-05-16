pragma solidity >= 0.6.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestERC721 is ERC721 {
  constructor() ERC721('ZKOPRU721', 'ZNFT') public {
    for (uint i = 0; i < 10; i++) {
      _mint(msg.sender, i);
    }
  }
}