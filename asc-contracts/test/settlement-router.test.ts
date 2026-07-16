import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 24 * 60 * 60;

async function deployFixture() {
  const [deployer, treasury, orchestrator, agentA, agentB, agentC, updater, stranger] =
    await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockERC20Permit");
  const token = await Token.deploy();
  await token.waitForDeployment();

  const Factory = await ethers.getContractFactory("SettlementRouterFactory");
  const factory = await Factory.deploy(await token.getAddress(), treasury.address, 50, updater.address);
  await factory.waitForDeployment();

  const reputationOracle = await ethers.getContractAt("ReputationOracle", await factory.reputationOracle());
  const feeRegistry = await ethers.getContractAt("FeeRegistry", await factory.feeRegistry());

  await factory.connect(deployer).createRouter(orchestrator.address);
  const routerAddress = await factory.orchestratorToRouter(orchestrator.address);
  const router = await ethers.getContractAt("SettlementRouter", routerAddress);

  // Fund everyone with plenty of mock USD.
  for (const signer of [orchestrator, agentA, agentB, agentC]) {
    await token.mint(signer.address, ethers.parseUnits("1000000", 6));
  }

  return {
    deployer,
    treasury,
    orchestrator,
    agentA,
    agentB,
    agentC,
    updater,
    stranger,
    token,
    factory,
    reputationOracle,
    feeRegistry,
    router,
  };
}

async function createStandardTask(
  fx: Awaited<ReturnType<typeof deployFixture>>,
  overrides: { payouts?: bigint[]; bondOverridesBps?: bigint[]; deadlineOffset?: number } = {}
) {
  const { router, orchestrator, agentA, agentB, agentC } = fx;
  const agents = [agentA.address, agentB.address, agentC.address];
  const payouts = overrides.payouts ?? [ethers.parseUnits("30", 6), ethers.parseUnits("10", 6), ethers.parseUnits("10", 6)];
  const bondOverridesBps = overrides.bondOverridesBps ?? [0n, 0n, 0n];
  const deadline = (await time.latest()) + (overrides.deadlineOffset ?? 3600);
  const taskId = ethers.id("task-" + Math.random());

  const tx = await router.connect(orchestrator).createTask(taskId, agents, payouts, bondOverridesBps, deadline);
  await tx.wait();
  const escrowAddress = await router.taskEscrow(taskId);
  const escrow = await ethers.getContractAt("TaskEscrow", escrowAddress);

  return { taskId, agents, payouts, deadline, escrow };
}

describe("FeeRegistry", function () {
  it("rejects a fee above the 5% hard cap at construction and via setProtocolFee", async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("FeeRegistry");
    await expect(Factory.deploy(owner.address, treasury.address, 501)).to.be.revertedWith(
      "FeeRegistry: fee exceeds cap"
    );

    const reg = await Factory.deploy(owner.address, treasury.address, 50);
    await expect(reg.connect(treasury).setProtocolFee(100)).to.be.revertedWith("FeeRegistry: not owner");
    await expect(reg.setProtocolFee(501)).to.be.revertedWith("FeeRegistry: fee exceeds cap");
    await reg.setProtocolFee(200);
    expect(await reg.protocolFeeBps()).to.equal(200n);
  });
});

describe("ReputationOracle bond tiers", function () {
  it("defaults unseen agents to PROTOSTAR (300) => 100% bond, and tiers correctly as score rises", async function () {
    const { reputationOracle, updater, agentA } = await deployFixture();

    expect(await reputationOracle.getScore(agentA.address)).to.equal(300n);
    expect(await reputationOracle.getBondRequirementBps(agentA.address)).to.equal(10000n);

    await reputationOracle.connect(updater).reportScore(agentA.address, 550);
    expect(await reputationOracle.getBondRequirementBps(agentA.address)).to.equal(5000n); // NEUTRON

    await reputationOracle.connect(updater).reportScore(agentA.address, 720);
    expect(await reputationOracle.getBondRequirementBps(agentA.address)).to.equal(2500n); // PULSAR

    await reputationOracle.connect(updater).reportScore(agentA.address, 830);
    expect(await reputationOracle.getBondRequirementBps(agentA.address)).to.equal(1000n); // QUASAR
  });

  it("only the updater can report scores, and scores must stay in the 300-850 range", async function () {
    const { reputationOracle, stranger, updater, agentA } = await deployFixture();
    await expect(reputationOracle.connect(stranger).reportScore(agentA.address, 500)).to.be.revertedWith(
      "ReputationOracle: not updater"
    );
    await expect(reputationOracle.connect(updater).reportScore(agentA.address, 851)).to.be.revertedWith(
      "ReputationOracle: score out of range"
    );
  });
});

describe("SettlementRouterFactory", function () {
  it("gives each orchestrator exactly one router", async function () {
    const { factory, orchestrator } = await deployFixture();
    await expect(factory.createRouter(orchestrator.address)).to.be.revertedWith(
      "SettlementRouterFactory: router exists"
    );
  });
});

describe("SettlementRouter.createTask", function () {
  it("deploys a TaskEscrow clone, pulls bond floors from the oracle, and lets overrides only raise them", async function () {
    const fx = await deployFixture();
    const { router, orchestrator, agentA, agentB, agentC, reputationOracle, updater } = fx;

    // agentA stays default (PROTOSTAR, 100%). agentB becomes QUASAR (10% floor)
    // but the orchestrator overrides it up to 40%. agentC becomes QUASAR too,
    // with a 0 override, so the floor (10%) should win.
    await reputationOracle.connect(updater).reportScore(agentB.address, 830);
    await reputationOracle.connect(updater).reportScore(agentC.address, 830);

    const payouts = [ethers.parseUnits("30", 6), ethers.parseUnits("10", 6), ethers.parseUnits("10", 6)];
    const { escrow, taskId } = await createStandardTask(fx, { payouts, bondOverridesBps: [0n, 4000n, 0n] });

    expect(await escrow.bondRequired(agentA.address)).to.equal((payouts[0] * 10000n) / 10000n); // 100%
    expect(await escrow.bondRequired(agentB.address)).to.equal((payouts[1] * 4000n) / 10000n); // override wins (40% > 10% floor)
    expect(await escrow.bondRequired(agentC.address)).to.equal((payouts[2] * 1000n) / 10000n); // floor wins (10%)

    expect(await escrow.taskBudget()).to.equal(payouts[0] + payouts[1] + payouts[2]);
    expect(await router.taskEscrow(taskId)).to.equal(await escrow.getAddress());
  });

  it("only the orchestrator can create a task on its own router", async function () {
    const fx = await deployFixture();
    const { router, stranger, agentA } = fx;
    const deadline = (await time.latest()) + 3600;
    await expect(
      router.connect(stranger).createTask(ethers.id("x"), [agentA.address], [1n], [0n], deadline)
    ).to.be.revertedWith("SettlementRouter: not orchestrator");
  });

  it("rejects a duplicate taskId and a past deadline", async function () {
    const fx = await deployFixture();
    const { router, orchestrator, agentA } = fx;
    const deadline = (await time.latest()) + 3600;
    const taskId = ethers.id("dup");
    await router.connect(orchestrator).createTask(taskId, [agentA.address], [1n], [0n], deadline);
    await expect(
      router.connect(orchestrator).createTask(taskId, [agentA.address], [1n], [0n], deadline)
    ).to.be.revertedWith("SettlementRouter: task exists");

    await expect(
      router
        .connect(orchestrator)
        .createTask(ethers.id("past"), [agentA.address], [1n], [0n], (await time.latest()) - 1)
    ).to.be.revertedWith("SettlementRouter: deadline in past");
  });
});

describe("TaskEscrow funding", function () {
  it("accepts task budget and bond deposits, rejects deposits from unknown agents", async function () {
    const fx = await deployFixture();
    const { token, orchestrator, agentA, agentB, agentC } = fx;
    const { escrow, payouts } = await createStandardTask(fx);

    await token.connect(orchestrator).approve(await escrow.getAddress(), payouts[0] + payouts[1] + payouts[2]);
    await escrow.connect(orchestrator).depositTaskBudget(payouts[0] + payouts[1] + payouts[2]);

    const bondA = await escrow.bondRequired(agentA.address);
    await token.connect(agentA).approve(await escrow.getAddress(), bondA);
    await escrow.connect(agentA).depositBond(agentA.address, bondA);
    expect(await escrow.bondDeposited(agentA.address)).to.equal(bondA);

    const [, , , , , , , stranger] = await ethers.getSigners();
    await token.mint(stranger.address, ethers.parseUnits("1000", 6));
    await token.connect(stranger).approve(await escrow.getAddress(), 1n);
    await expect(escrow.connect(stranger).depositBond(stranger.address, 1n)).to.be.revertedWith(
      "TaskEscrow: unknown agent"
    );
  });

  it("depositBondWithPermit works with a real EIP-2612 signature and no prior approve()", async function () {
    const fx = await deployFixture();
    const { token, agentB } = fx;
    const { escrow } = await createStandardTask(fx);

    const bondB = await escrow.bondRequired(agentB.address);
    const escrowAddress = await escrow.getAddress();
    const deadline = (await time.latest()) + 3600;

    const domain = {
      name: await token.name(),
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const nonce = await token.nonces(agentB.address);
    const value = {
      owner: agentB.address,
      spender: escrowAddress,
      value: bondB,
      nonce,
      deadline,
    };
    const signature = await agentB.signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(signature);

    await escrow.connect(agentB).depositBondWithPermit(agentB.address, bondB, deadline, v, r, s);
    expect(await escrow.bondDeposited(agentB.address)).to.equal(bondB);
    expect(await token.allowance(agentB.address, escrowAddress)).to.equal(0n);
  });
});

describe("SettlementRouter.settleTask", function () {
  async function fundedTask(fx: Awaited<ReturnType<typeof deployFixture>>) {
    const { token, orchestrator, agentA, agentB, agentC } = fx;
    const created = await createStandardTask(fx);
    const { escrow, payouts } = created;

    await token.connect(orchestrator).approve(await escrow.getAddress(), payouts[0] + payouts[1] + payouts[2]);
    await escrow.connect(orchestrator).depositTaskBudget(payouts[0] + payouts[1] + payouts[2]);

    for (const agent of [agentA, agentB, agentC]) {
      const bond = await escrow.bondRequired(agent.address);
      if (bond > 0n) {
        await token.connect(agent).approve(await escrow.getAddress(), bond);
        await escrow.connect(agent).depositBond(agent.address, bond);
      }
    }

    return created;
  }

  it("nets a payment graph, pays the protocol fee, returns every bond, and refunds the remainder", async function () {
    const fx = await deployFixture();
    const { router, token, treasury, orchestrator, agentA, agentB, agentC } = fx;
    const { taskId, escrow } = await fundedTask(fx);

    // Off-chain netting result for A->B $30, B->C $20, C->A $10:
    // net A +$30-$10=+$20, B +$30-$20... (this test just exercises the on-chain
    // math directly with a simple net vector that sums to <= the $50 budget).
    const netAgents = [agentA.address, agentB.address, agentC.address];
    const netPayouts = [ethers.parseUnits("20", 6), ethers.parseUnits("10", 6), ethers.parseUnits("10", 6)];

    const bondA = await escrow.bondRequired(agentA.address);
    const bondB = await escrow.bondRequired(agentB.address);
    const bondC = await escrow.bondRequired(agentC.address);

    const balBeforeA = await token.balanceOf(agentA.address);
    const balBeforeB = await token.balanceOf(agentB.address);
    const balBeforeC = await token.balanceOf(agentC.address);
    const balBeforeOrchestrator = await token.balanceOf(orchestrator.address);
    const balBeforeTreasury = await token.balanceOf(treasury.address);

    const totalFlow = netPayouts.reduce((a, b) => a + b, 0n);
    const expectedFee = (totalFlow * 50n) / 10000n; // 0.5%

    await expect(router.connect(orchestrator).settleTask(taskId, netAgents, netPayouts))
      .to.emit(router, "TaskSettled")
      .withArgs(taskId, await escrow.getAddress(), totalFlow, expectedFee);

    expect(await token.balanceOf(agentA.address)).to.equal(balBeforeA + netPayouts[0] + bondA);
    expect(await token.balanceOf(agentB.address)).to.equal(balBeforeB + netPayouts[1] + bondB);
    expect(await token.balanceOf(agentC.address)).to.equal(balBeforeC + netPayouts[2] + bondC);
    expect(await token.balanceOf(treasury.address)).to.equal(balBeforeTreasury + expectedFee);

    const taskBudget = ethers.parseUnits("50", 6);
    const remainder = taskBudget - totalFlow - expectedFee;
    expect(await token.balanceOf(orchestrator.address)).to.equal(balBeforeOrchestrator + remainder);

    expect(await escrow.isSettled()).to.equal(true);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("reverts if net payouts + fee would exceed the task budget", async function () {
    const fx = await deployFixture();
    const { router, orchestrator, agentA } = fx;
    const { taskId } = await fundedTask(fx);

    await expect(
      router.connect(orchestrator).settleTask(taskId, [agentA.address], [ethers.parseUnits("999", 6)])
    ).to.be.revertedWith("TaskEscrow: payouts exceed budget");
  });

  it("cannot be called by anyone other than the orchestrator, or directly on the escrow bypassing the router", async function () {
    const fx = await deployFixture();
    const { router, stranger, agentA } = fx;
    const { taskId, escrow } = await fundedTask(fx);

    await expect(router.connect(stranger).settleTask(taskId, [agentA.address], [1n])).to.be.revertedWith(
      "SettlementRouter: not orchestrator"
    );
    await expect(escrow.connect(stranger).settle([agentA.address], [1n], 0, stranger.address)).to.be.revertedWith(
      "TaskEscrow: not router"
    );
  });
});

describe("SettlementRouter.slashAgent", function () {
  it("moves up to the posted bond to a recipient and never more", async function () {
    const fx = await deployFixture();
    const { router, token, orchestrator, agentA, stranger } = fx;
    const { taskId, escrow } = await createStandardTask(fx);

    const bondA = await escrow.bondRequired(agentA.address);
    await token.connect(agentA).approve(await escrow.getAddress(), bondA);
    await escrow.connect(agentA).depositBond(agentA.address, bondA);

    const half = bondA / 2n;
    await expect(router.connect(orchestrator).slashAgent(taskId, agentA.address, half, stranger.address))
      .to.emit(router, "TaskSlashed")
      .withArgs(taskId, agentA.address, half, stranger.address);

    expect(await token.balanceOf(stranger.address)).to.equal(half);
    expect(await escrow.bondDeposited(agentA.address)).to.equal(bondA - half);

    await expect(
      router.connect(orchestrator).slashAgent(taskId, agentA.address, bondA, stranger.address)
    ).to.be.revertedWith("TaskEscrow: invalid slash amount");
  });
});

describe("TaskEscrow.cancel", function () {
  it("refunds all bonds and the remaining task budget to the orchestrator", async function () {
    const fx = await deployFixture();
    const { token, orchestrator, agentA, agentB } = fx;
    const { escrow, payouts } = await createStandardTask(fx);

    const total = payouts[0] + payouts[1] + payouts[2];
    await token.connect(orchestrator).approve(await escrow.getAddress(), total);
    await escrow.connect(orchestrator).depositTaskBudget(total);

    const bondA = await escrow.bondRequired(agentA.address);
    await token.connect(agentA).approve(await escrow.getAddress(), bondA);
    await escrow.connect(agentA).depositBond(agentA.address, bondA);

    const balBeforeOrchestrator = await token.balanceOf(orchestrator.address);
    const balBeforeAgentA = await token.balanceOf(agentA.address);

    await expect(escrow.connect(orchestrator).cancel())
      .to.emit(escrow, "Cancelled")
      .withArgs(total, bondA);

    expect(await token.balanceOf(agentA.address)).to.equal(balBeforeAgentA + bondA);
    expect(await token.balanceOf(orchestrator.address)).to.equal(balBeforeOrchestrator + total);
    expect(await escrow.isCancelled()).to.equal(true);

    await expect(escrow.connect(orchestrator).cancel()).to.be.revertedWith("TaskEscrow: task closed");
  });

  it("only the orchestrator can cancel", async function () {
    const fx = await deployFixture();
    const { stranger } = fx;
    const { escrow } = await createStandardTask(fx);
    await expect(escrow.connect(stranger).cancel()).to.be.revertedWith("TaskEscrow: not orchestrator");
  });
});

describe("TaskEscrow.emergencyWithdraw", function () {
  it("reverts before the 7-day post-deadline timelock, succeeds after", async function () {
    const fx = await deployFixture();
    const { token, orchestrator } = fx;
    const { escrow, payouts, deadline } = await createStandardTask(fx, { deadlineOffset: 3600 });

    const total = payouts[0] + payouts[1] + payouts[2];
    await token.connect(orchestrator).approve(await escrow.getAddress(), total);
    await escrow.connect(orchestrator).depositTaskBudget(total);

    await expect(escrow.connect(orchestrator).emergencyWithdraw()).to.be.revertedWith(
      "TaskEscrow: timelock active"
    );

    await time.increaseTo(deadline + 7 * DAY + 1);

    const balBefore = await token.balanceOf(orchestrator.address);
    await expect(escrow.connect(orchestrator).emergencyWithdraw())
      .to.emit(escrow, "EmergencyWithdraw")
      .withArgs(orchestrator.address, total);
    expect(await token.balanceOf(orchestrator.address)).to.equal(balBefore + total);
  });

  it("cannot be used after a normal settlement", async function () {
    const fx = await deployFixture();
    const { router, token, orchestrator, agentA, agentB, agentC } = fx;
    const { taskId, escrow, payouts, deadline } = await createStandardTask(fx);

    const total = payouts[0] + payouts[1] + payouts[2];
    await token.connect(orchestrator).approve(await escrow.getAddress(), total);
    await escrow.connect(orchestrator).depositTaskBudget(total);

    // Leave room in the budget for the 0.5% protocol fee on top of the payouts.
    const netPayouts = [payouts[0] - (total * 50n) / 10000n, payouts[1], payouts[2]];
    await router.connect(orchestrator).settleTask(
      taskId,
      [agentA.address, agentB.address, agentC.address],
      netPayouts
    );

    await time.increaseTo(deadline + 7 * DAY + 1);
    await expect(escrow.connect(orchestrator).emergencyWithdraw()).to.be.revertedWith(
      "TaskEscrow: already settled"
    );
  });
});
