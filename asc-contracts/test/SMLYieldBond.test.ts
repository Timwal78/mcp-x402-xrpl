import { expect } from "chai";
import { ethers } from "hardhat";

describe("SMLYieldBond", () => {
  async function deployFixture() {
    const [protocolTreasury, operator, investorA, investorB] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();

    const Factory = await ethers.getContractFactory("SMLYieldBondFactory");
    const factory = await Factory.connect(operator).deploy(protocolTreasury.address);

    const fundingTarget = ethers.parseUnits("1000", 6);
    const repaymentCapMultiplier = 11500; // 115%
    const repaymentSplitBasisPoints = 1500; // 15%

    const tx = await factory
      .connect(operator)
      .deployBond(await token.getAddress(), fundingTarget, repaymentCapMultiplier, repaymentSplitBasisPoints);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "BondDeployed");
    const bondAddress = event!.args.bondAddress as string;
    const bond = await ethers.getContractAt("SMLYieldBond", bondAddress);

    await token.mint(investorA.address, ethers.parseUnits("600", 6));
    await token.mint(investorB.address, ethers.parseUnits("400", 6));

    return { token, factory, bond, protocolTreasury, operator, investorA, investorB, fundingTarget };
  }

  it("closes funding and routes protocol fee + operating capital once the target is reached", async () => {
    const { token, bond, protocolTreasury, operator, investorA, investorB } = await deployFixture();

    await token.connect(investorA).approve(await bond.getAddress(), ethers.parseUnits("600", 6));
    await token.connect(investorB).approve(await bond.getAddress(), ethers.parseUnits("400", 6));

    await bond.connect(investorA).fund(ethers.parseUnits("600", 6));
    await bond.connect(investorB).fund(ethers.parseUnits("400", 6));

    expect(await bond.isFundingClosed()).to.equal(true);

    const protocolFee = (1000n * 50n) / 10000n; // 0.5% of 1000
    expect(await token.balanceOf(protocolTreasury.address)).to.equal(ethers.parseUnits(protocolFee.toString(), 6));
    expect(await token.balanceOf(operator.address)).to.equal(
      ethers.parseUnits("1000", 6) - ethers.parseUnits(protocolFee.toString(), 6)
    );
  });

  it("splits incoming revenue pro-rata between investors until the repayment cap", async () => {
    const { token, bond, operator, investorA, investorB } = await deployFixture();

    await token.connect(investorA).approve(await bond.getAddress(), ethers.parseUnits("600", 6));
    await token.connect(investorB).approve(await bond.getAddress(), ethers.parseUnits("400", 6));
    await bond.connect(investorA).fund(ethers.parseUnits("600", 6));
    await bond.connect(investorB).fund(ethers.parseUnits("400", 6));

    await token.mint(operator.address, ethers.parseUnits("100", 6));
    await token.connect(operator).approve(await bond.getAddress(), ethers.parseUnits("100", 6));
    await bond.connect(operator).processRevenue(ethers.parseUnits("100", 6));

    const investorSplitTotal = (ethers.parseUnits("100", 6) * 1500n) / 10000n; // 15 tokens
    const investorAShare = (investorSplitTotal * 600n) / 1000n;
    const investorBShare = (investorSplitTotal * 400n) / 1000n;

    expect(await bond.amountRepaid(investorA.address)).to.equal(investorAShare);
    expect(await bond.amountRepaid(investorB.address)).to.equal(investorBShare);
  });

  it("rejects revenue routing from anyone other than the operator", async () => {
    const { bond, investorA } = await deployFixture();
    await expect(bond.connect(investorA).processRevenue(1)).to.be.revertedWith(
      "SMLBond: Only operator can route revenue"
    );
  });
});
