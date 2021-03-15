import { BigNumber, BigNumberish, BytesLike, Contract, Signer, utils as ethersUtils } from 'ethers'
import Transfer from '../../lib/Transfer'
import MerkleTree from '../../lib/MerkleTree'
import { expect } from 'chai'
import { expectBalanceOf, getRootHashFromTransferId, getTransferNonceFromEvent } from './utils'
import { isChainIdOptimism, isChainIdArbitrum, isChainIdXDai } from '../../config/utils'
import {
  CHAIN_IDS,
  TIMESTAMP_VARIANCE,
  DEAD_ADDRESS,
  ARB_CHAIN_ADDRESS
} from '../../config/constants'

/**
 * Canonical Bridge
 */

export const executeCanonicalBridgeSendTokens = async (
  l1_canonicalToken: Contract,
  l1_canonicalBridge: Contract,
  l2_canonicalToken: Contract,
  l2_messenger: Contract,
  account: Signer,
  amount: BigNumber
) => {
  await l1_canonicalToken
    .connect(account)
    .approve(l1_canonicalBridge.address, amount)
  await l1_canonicalBridge
    .connect(account)
    .sendTokens(
      l2_canonicalToken.address,
      await account.getAddress(),
      amount
    )
  await l2_messenger.relayNextMessage()
  await expectBalanceOf(l2_canonicalToken, account, amount)
}

export const executeCanonicalBridgeSendMessage = async (
  l1_messenger: Contract,
  l2_bridge: Contract,
  l2_messenger: Contract | string,
  sender: Signer,
  message: string,
  l2ChainId: BigNumber = BigNumber.from('0')
) => {
  const gasLimit: BigNumber = BigNumber.from('1000000')
  const params: any[] = [
    l2_bridge.address,
    message,
    gasLimit
  ]

  if (isChainIdArbitrum(l2ChainId)) {
    const arbitrumParams: any = getArbitrumMessageParams(l2_bridge, message)
    await l1_messenger
      .connect(sender)
      .sendL2Message(...arbitrumParams)
  } else if (isChainIdOptimism(l2ChainId)) {
    await l1_messenger
      .connect(sender)
      .sendMessage(...params)
  } else if (isChainIdXDai(l2ChainId)) {
    await l1_messenger
      .connect(sender)
      .requireToPassMessage(...params)
  } else {
    await l1_messenger
      .connect(sender)
      .sendMessage(...params)
  }

  // Prod deployments should pass in ZERO_ADDRESS for the l2_messenger param
  if (typeof l2_messenger === 'object') {
    await l2_messenger.relayNextMessage()
  }
}

/**
 * L1 Bridge
 */

export const executeL1BridgeSendToL2 = async (
  l1_canonicalToken: Contract,
  l1_bridge: Contract,
  l2_hopBridgeToken: Contract,
  l2_canonicalToken: Contract,
  l2_messenger: Contract,
  l2_uniswapRouter: Contract,
  sender: Signer,
  recipient: Signer,
  relayer: Signer,
  amount: BigNumber,
  amountOutMin: BigNumber,
  deadline: BigNumber,
  relayerFee: BigNumber,
  l2ChainId: BigNumber
) => {
  // Get state before transaction
  // The test suite setup might not have defined the Uniswap Router yet
  let expectedAmountAfterSlippage: BigNumber
  if (!amountOutMin.eq(0) || !deadline.eq(0)) {
    const expectedAmounts: BigNumber[] = await l2_uniswapRouter.getAmountsOut(
      amount,
      [l2_canonicalToken.address, l2_hopBridgeToken.address]
    )

    expectedAmountAfterSlippage = expectedAmounts[1]
  }

  const senderL1CanonicalTokenBalanceBefore: BigNumber = await l1_canonicalToken.balanceOf(await sender.getAddress())
  const recipientL2CanonicalTokenBalanceBefore: BigNumber = await l2_canonicalToken.balanceOf(await recipient.getAddress())
  const recipientL2HopBridgeTokenBalanceBefore: BigNumber = await l2_hopBridgeToken.balanceOf(await recipient.getAddress())
  const relayerL2HopBridgeTokenBalanceBefore: BigNumber = await l2_hopBridgeToken.balanceOf(await relayer.getAddress())

  // Perform transaction
  await l1_canonicalToken.connect(sender).approve(l1_bridge.address, amount)
  await l1_bridge
    .connect(sender)
    .sendToL2(
      l2ChainId,
      await recipient.getAddress(),
      amount,
      amountOutMin,
      deadline,
      relayerFee
    )
  await l2_messenger.connect(relayer).relayNextMessage()

  // Validate state after transaction
  // If the relayer is the same account as the recipient, the check will happen below
  if (recipient !== relayer) {
    await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(relayerFee))
  }
  await expectBalanceOf(l1_canonicalToken, sender, senderL1CanonicalTokenBalanceBefore.sub(amount))

  if (amountOutMin.eq(0) && deadline.eq(0)) {
    await expectBalanceOf(l2_canonicalToken, recipient, recipientL2CanonicalTokenBalanceBefore)

    if (recipient === relayer) {
      await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore.add(amount))
      await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(amount))
    } else {
      await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore.add(amount).sub(relayerFee))
      await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(relayerFee))
    }
  } else {
    // The recipient will either have the bridge token (if successful swap) or the canonical token
    try {
      await expectBalanceOf(l2_canonicalToken, recipient, recipientL2CanonicalTokenBalanceBefore.add(expectedAmountAfterSlippage))
      if (recipient === relayer) {
        await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore.add(relayerFee))
        await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(relayerFee))
      } else {
        await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore)
        await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(relayerFee))
      }
    } catch {
      await expectBalanceOf(l2_canonicalToken, recipient, 0)
      if (recipient === relayer) {
        await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore.add(amount))
        await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(amount))
      } else {
        await expectBalanceOf(l2_hopBridgeToken, recipient, recipientL2HopBridgeTokenBalanceBefore.add(amount).sub(relayerFee))
        await expectBalanceOf(l2_hopBridgeToken, relayer, relayerL2HopBridgeTokenBalanceBefore.add(relayerFee))

      }
    }
  }
}

export const executeBridgeWithdraw = async (
  destinationCanonicalToken: Contract,
  destinationBridge: Contract,
  originBridge: Contract,
  transfer: Transfer,
  bonder: Signer
) => {
  const transferNonce: string = await getTransferNonceFromEvent(originBridge)
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const tree: MerkleTree = new MerkleTree([transferId])
  const transferRootHash: Buffer = tree.getRoot()
  const proof: Buffer[] = tree.getProof(transferId)

  const { rootHash } = getRootHashFromTransferId(transferId)

  // Get state before transaction
  const recipientBalanceBefore: BigNumber = await destinationCanonicalToken.balanceOf(await transfer.recipient.getAddress())
  const bonderBalanceBefore: BigNumber = await destinationCanonicalToken.balanceOf(await bonder.getAddress())
  const transferRootAmountWithdrawnBefore: BigNumber = (await destinationBridge.getTransferRoot(rootHash, transfer.amount))[1]
  let isTransferIdSpent: boolean = await destinationBridge.isTransferIdSpent(transferId)
  expect(isTransferIdSpent).to.eq(false)

  // Perform transaction
  await destinationBridge
    .connect(bonder)
    .withdraw(
      await transfer.recipient.getAddress(),
      transfer.amount,
      transferNonce,
      transfer.bonderFee,
      transfer.amountOutMin,
      transfer.deadline,
      transferRootHash,
      transfer.amount,
      proof
    )

  // Validate state after transaction
  const transferRootAmountWithdrawnAfter: BigNumber = (await destinationBridge.getTransferRoot(rootHash, transfer.amount))[1]

  // NOTE: Unbonded withdrawals do not pay the bonder
  await expectBalanceOf(
    destinationCanonicalToken,
    transfer.recipient,
    recipientBalanceBefore.add(transfer.amount)
  )

  await expectBalanceOf(
    destinationCanonicalToken,
    bonder,
    bonderBalanceBefore
  )

  expect(transferRootAmountWithdrawnAfter).to.eq(transferRootAmountWithdrawnBefore.add(transfer.amount))
  isTransferIdSpent = await destinationBridge.isTransferIdSpent(transferId)
  expect(isTransferIdSpent).to.eq(true)

}
export const executeBridgeBondWithdrawal = async (
  destinationReceiptToken: Contract,
  destinationBridge: Contract,
  originBridge: Contract,
  transfer: Transfer,
  bonder: Signer
) => {
  // Get state before transaction
  const transferNonce = await getTransferNonceFromEvent(originBridge)
  const senderBalanceBefore: BigNumber = await destinationReceiptToken.balanceOf(await transfer.sender.getAddress())
  const bonderBalanceBefore: BigNumber = await destinationReceiptToken.balanceOf(await bonder.getAddress())

  // Perform transaction
  await destinationBridge 
    .connect(bonder)
    .bondWithdrawal(
      await transfer.recipient.getAddress(),
      transfer.amount,
      transferNonce,
      transfer.bonderFee
    )

  // Validate state after transaction
  let senderDestinationReceiptTokenBalance: BigNumber
  let recipientL1CanonicalTokenBalance: BigNumber
  if(transfer.sender === transfer.recipient) {
    senderDestinationReceiptTokenBalance = senderBalanceBefore.add(transfer.amount).sub(transfer.bonderFee)
    recipientL1CanonicalTokenBalance = senderDestinationReceiptTokenBalance 
  } else {
    senderDestinationReceiptTokenBalance = senderBalanceBefore
    recipientL1CanonicalTokenBalance = transfer.amount.sub(transfer.bonderFee)
  }
  await expectBalanceOf(
    destinationReceiptToken,
    transfer.sender,
    senderDestinationReceiptTokenBalance 
  )

  await expectBalanceOf(
    destinationReceiptToken,
    transfer.recipient,
    recipientL1CanonicalTokenBalance
  )

  await expectBalanceOf(
    destinationReceiptToken,
    bonder,
    bonderBalanceBefore.add(transfer.bonderFee)
  )
}

export const executeL1BridgeBondTransferRoot = async (
  l1_bridge: Contract,
  l2_bridge: Contract,
  transfer: Transfer,
  bonder: Signer,
  timeIncrease: number,
  customTransferNonce: string | null = null
) => {
  let transferNonce: string
  if (customTransferNonce) {
    transferNonce = customTransferNonce
  } else {
    transferNonce = await getTransferNonceFromEvent(l2_bridge)
  }
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const { rootHash } = getRootHashFromTransferId(transferId)

  // Perform transaction
  await l1_bridge
    .connect(bonder)
    .bondTransferRoot(rootHash, transfer.chainId, transfer.amount)

  // Validate state after transaction
  const currentTime: number = Math.floor(Date.now() / 1000)
  const timeSlot: number = await l1_bridge.getTimeSlot(currentTime + timeIncrease)
  const bondAmount: string = await l1_bridge.getBondForTransferAmount(transfer.amount)
  const timeSlotToAmountBonded: number = await l1_bridge.timeSlotToAmountBonded(timeSlot)
  const transferBond: number = await l1_bridge.timeSlotToAmountBonded(timeSlot)
  const transferRoot: number = await l1_bridge.getTransferRoot(rootHash, transfer.amount)

  expect(timeSlotToAmountBonded).to.eq(bondAmount)
  expect(transferBond).to.eq(bondAmount)
  if (transfer.chainId === CHAIN_IDS.ETHEREUM.MAINNET) {
    expect(transferRoot[0]).to.eq(transfer.amount)
    expect(transferRoot[1]).to.eq(BigNumber.from('0'))
    expect(transferRoot[2].toNumber()).to.be.closeTo(
      currentTime,
      TIMESTAMP_VARIANCE
    )
  }
}

export const executeBridgeSettleBondedWithdrawal = async (
  destinationBridge: Contract,
  originBridge: Contract,
  transfer: Transfer,
  bonder: Signer
) => {
  const transferNonce = await getTransferNonceFromEvent(originBridge)
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const { rootHash } = getRootHashFromTransferId(transferId)
  const tree: MerkleTree = new MerkleTree([transferId])
  const proof: Buffer[] = tree.getProof(transferId)

  // Get state before transaction
  const bondedAmountBefore: BigNumber = await destinationBridge.getCredit(await bonder.getAddress())

  // Perform transaction
  await destinationBridge
    .connect(bonder)
    .settleBondedWithdrawal(
      await bonder.getAddress(),
      transferId,
      rootHash,
      transfer.amount,
      proof
    )

  // Validate state after transaction
  const currentTime: number = Math.floor(Date.now() / 1000)
  const transferRoot: number = await destinationBridge.getTransferRoot(rootHash, transfer.amount)
  const credit = await destinationBridge.getCredit(await bonder.getAddress())
  const expectedCredit: BigNumber = bondedAmountBefore.add(transfer.amount)
  expect(transferRoot[0]).to.eq(transfer.amount)
  expect(transferRoot[1]).to.eq(transfer.amount)
  expect(transferRoot[2].toNumber()).to.be.closeTo(
    currentTime,
    TIMESTAMP_VARIANCE
  )
  expect(credit).to.eq(expectedCredit)
}

export const executeBridgeSettleBondedWithdrawals = async (
  l1_bridge: Contract,
  l2_bridge: Contract,
  transfer: Transfer,
  bonder: Signer,
  numTransfers: number = 1
) => {
  let transferNonces: string[] = []
  let transferIds: Buffer[] = []
  for (let i = 0; i < numTransfers; i++) {
    transferNonces.push(await getTransferNonceFromEvent(l2_bridge))
    transferIds.push(await transfer.getTransferId(transferNonces[i]))
  }

  // TODO: Needs to be more dynamic
  const { rootHash } = getRootHashFromTransferId(transferIds[0])

  // Get state before transaction
  const bondedAmountBefore: BigNumber = await l1_bridge.getCredit(await bonder.getAddress())

  // Perform transaction
  await l1_bridge
    .connect(bonder)
    .settleBondedWithdrawals(
      await bonder.getAddress(),
      transferIds,
      transfer.amount
    )

  // Validate state after transaction
  const currentTime: number = Math.floor(Date.now() / 1000)
  const transferRoot: number = await l1_bridge.getTransferRoot(rootHash, transfer.amount)
  const credit = await l1_bridge.getCredit(await bonder.getAddress())
  const expectedCredit: BigNumber = bondedAmountBefore.add(transfer.amount)
  expect(transferRoot[0]).to.eq(transfer.amount)
  expect(transferRoot[1]).to.eq(transfer.amount)
  expect(transferRoot[2].toNumber()).to.be.closeTo(
    currentTime,
    TIMESTAMP_VARIANCE
  )
  expect(credit).to.eq(expectedCredit)
}

export const executeL1BridgeChallengeTransferBond = async (
  l1_canonicalToken: Contract,
  l1_bridge: Contract,
  l2_bridge: Contract,
  amount: BigNumber,
  bonder: Signer,
  challenger: Signer,
  transfer: Transfer,
  customTransferNonce: string | null = null
) => {
  let transferNonce: string
  if (customTransferNonce) {
    transferNonce = customTransferNonce
  } else {
    transferNonce = await getTransferNonceFromEvent(l2_bridge)
  }
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const { rootHash } = getRootHashFromTransferId(transferId)
  const challengeAmount: BigNumber = await l1_bridge.getChallengeAmountForTransferAmount(amount)
  const transferRootId: string = await l1_bridge.getTransferRootId(rootHash, amount)

  // Get state before transaction
  const challengerBalanceBefore: BigNumber = await l1_canonicalToken.balanceOf(await challenger.getAddress())
  const debitBefore: BigNumber = await l1_bridge.getDebitAndAdditionalDebit(await bonder.getAddress())
  const bridgeBalanceBefore: BigNumber = await l1_canonicalToken.balanceOf(l1_bridge.address)

  // Perform transaction
  await l1_canonicalToken
    .connect(challenger)
    .approve(l1_bridge.address, challengeAmount)
  await l1_bridge.connect(challenger).challengeTransferBond(rootHash, amount)

  // Validate state after transaction
  await expectBalanceOf(
    l1_canonicalToken,
    challenger,
    challengerBalanceBefore.sub(challengeAmount)
  )

  const transferBond = await l1_bridge.transferBonds(transferRootId)
  const currentTime: number = Math.floor(Date.now() / 1000)
  expect(transferBond[3].toNumber()).to.be.closeTo(
    currentTime,
    TIMESTAMP_VARIANCE
  )
  expect(transferBond[4]).to.eq(await challenger.getAddress())
  expect(transferBond[5]).to.eq(false)

  const timeSlot: string = await l1_bridge.getTimeSlot(currentTime)
  const bondAmountForTimeSlot: number = await l1_bridge.timeSlotToAmountBonded(timeSlot)
  expect(bondAmountForTimeSlot).to.eq(BigNumber.from('0'))

  expectBalanceOf(l1_canonicalToken, l1_bridge, bridgeBalanceBefore.add(challengeAmount))

  // This will be the same, as the debit has already been counted
  const debitAfter: BigNumber = await l1_bridge.getDebitAndAdditionalDebit(await bonder.getAddress())
  expect(debitBefore).to.eq(debitAfter)
}

export const executeL1BridgeResolveChallenge = async (
  l1_canonicalToken: Contract,
  l1_bridge: Contract,
  originBridge: Contract,
  amount: BigNumber,
  bonder: Signer,
  challenger: Signer,
  transfer: Transfer,
  shouldResolveSuccessfully: boolean,
  didBonderWaitMinTransferRootTime: boolean = true,
  customTransferNonce: string | null = null
) => {
  let transferNonce: string
  if (customTransferNonce) {
    transferNonce = customTransferNonce
  } else {
    transferNonce = await getTransferNonceFromEvent(originBridge)
  }
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const { rootHash } = getRootHashFromTransferId(transferId)
  const challengeAmount: BigNumber = await l1_bridge.getChallengeAmountForTransferAmount(amount)
  const bondAmount: BigNumber = await l1_bridge.getBondForTransferAmount(amount)
  const transferRootId: string = await l1_bridge.getTransferRootId(rootHash, amount)

  // Get state before transaction
  const creditBefore: BigNumber = await l1_bridge.getCredit(await bonder.getAddress())
  const challengerBalanceBefore: BigNumber = await l1_canonicalToken.balanceOf(await challenger.getAddress())

  // Perform transaction
  await l1_bridge.resolveChallenge(rootHash, amount)

  // Validate state after transaction
  const transferBond: number = await l1_bridge.transferBonds(transferRootId)
  const creditAfter: BigNumber = await l1_bridge.getCredit(await bonder.getAddress())

  if (!shouldResolveSuccessfully) {
    expect(transferBond[5]).to.eq(true)
    let expectedCredit: BigNumber = creditBefore.add(bondAmount)
    if (didBonderWaitMinTransferRootTime) {
      expectedCredit = expectedCredit.add(challengeAmount)
    }
    expect(creditAfter).to.eq(expectedCredit)
  } else {
    expect(transferBond[5]).to.eq(true)

    // Credit should not have changed
    expect(creditAfter).to.eq(creditBefore)

    // DEAD address should have tokens
    const balanceAfter: BigNumber = await l1_canonicalToken.balanceOf(DEAD_ADDRESS)
    expect(balanceAfter.toString()).to.eq(BigNumber.from(challengeAmount).div(4).toString())

    // Challenger should have tokens
    // NOTE: the challenge amount is subtracted to mimic the amount sent to the contract during the challenge
    const expectedChallengerTokenAmount: BigNumber = challengerBalanceBefore.add(challengeAmount.mul(7).div(4))
    await expectBalanceOf(l1_canonicalToken, challenger, expectedChallengerTokenAmount)
  }
}

export const executeBridgeRescueTransferRoot = async (
  destinationPayoutToken: Contract,
  originBridge: Contract,
  receivingBridge: Contract,
  amount: BigNumber,
  governance: Signer,
  transfer: Transfer,
  customTransferNonce: string | null = null
) => {
  let transferNonce: string
  if (customTransferNonce) {
    transferNonce = customTransferNonce
  } else {
    transferNonce = await getTransferNonceFromEvent(originBridge)
  }
  const transferId: Buffer = await transfer.getTransferId(transferNonce)
  const { rootHash } = getRootHashFromTransferId(transferId)

  // Get state before transaction
  const governanceAmountBefore: BigNumber = await destinationPayoutToken.balanceOf(await governance.getAddress())
  const transferRootAmountWithdrawnBefore: BigNumber = (await receivingBridge.getTransferRoot(rootHash, transfer.amount))[1]

  // Perform transaction
  // TODO: Technically we should explicitly send from Governance. Need to rework some other setup to do so properly
  await receivingBridge.rescueTransferRoot(rootHash, amount, await governance.getAddress())

  // Validate state after transaction
  const transferRootAmountWithdrawnAfter: BigNumber = (await receivingBridge.getTransferRoot(rootHash, transfer.amount))[1]
  expect(transferRootAmountWithdrawnAfter).to.eq(transferRootAmountWithdrawnBefore.add(transfer.amount))

  await expectBalanceOf(destinationPayoutToken, governance, governanceAmountBefore.add(transfer.amount))
}

/**
 * L2 Bridge
 */

export const executeL2BridgeSend = async (
  l2_hopBridgeToken: Contract,
  l2_bridge: Contract,
  transfer: Transfer,
  expectedTransferIndex: BigNumber = BigNumber.from('0')
) => {
  // Get state before transaction
  const bridgeTotalSupplyBefore: BigNumber = await l2_hopBridgeToken.totalSupply()
  const senderBalanceBefore: BigNumber = await l2_hopBridgeToken.balanceOf(await transfer.sender.getAddress())
  const pendingAmountBefore: BigNumber = await l2_bridge.pendingAmountForChainId(
    transfer.chainId
  )

  // Perform transaction
  await l2_bridge
    .connect(transfer.sender)
    .send(
      transfer.chainId,
      await transfer.recipient.getAddress(),
      transfer.amount,
      transfer.bonderFee,
      transfer.amountOutMin,
      transfer.deadline
    )

  // Perform transaction
  // Validate state after transaction
  const bridgeTotalSupplyAfter: BigNumber = await l2_hopBridgeToken.totalSupply()
  expect(bridgeTotalSupplyAfter).to.eq(bridgeTotalSupplyBefore.sub(transfer.amount))
  await expectBalanceOf(
    l2_hopBridgeToken,
    transfer.sender,
    senderBalanceBefore.sub(transfer.amount)
  )

  // Verify state
  const transferNonce = await getTransferNonceFromEvent(l2_bridge, expectedTransferIndex)
  const expectedPendingTransferHash: Buffer = await transfer.getTransferId(transferNonce)

  const pendingAmount: BigNumber = await l2_bridge.pendingAmountForChainId(
    transfer.chainId
  )
  const expectedPendingAmount: BigNumber = pendingAmountBefore.add(transfer.amount)
  expect(pendingAmount).to.eq(expectedPendingAmount)

  const transfersSentEvent = (
    await l2_bridge.queryFilter(l2_bridge.filters.TransferSent())
  )[expectedTransferIndex.toNumber()]
  const transferSentArgs = transfersSentEvent.args
  expect(transferSentArgs[0]).to.eq(
    '0x' + expectedPendingTransferHash.toString('hex')
  )
  expect(transferSentArgs[1]).to.eq(await transfer.recipient.getAddress())
  expect(transferSentArgs[2]).to.eq(transfer.amount)
  expect(transferSentArgs[3]).to.eq(transferNonce)
  expect(transferSentArgs[4]).to.eq(transfer.bonderFee)
}

export const executeL2BridgeSwapAndSend = async (
  l2_bridge: Contract,
  l2_canonicalToken: Contract,
  l2_hopBridgeToken: Contract,
  l2_uniswapRouter: Contract,
  l2_uniswapWrapper: Contract,
  transfer: Transfer
) => {
  // Get state before transaction
  const senderBalanceBefore: BigNumber = await l2_canonicalToken.balanceOf(await transfer.sender.getAddress())
  const expectedAmounts: BigNumber[] = await l2_uniswapRouter.getAmountsOut(
    transfer.amount,
    [l2_canonicalToken.address, l2_hopBridgeToken.address]
  )
  const expectedAmountAfterSlippage: BigNumber = expectedAmounts[1]

  // Perform transaction
  await l2_canonicalToken
    .connect(transfer.sender)
    .approve(l2_uniswapWrapper.address, transfer.amount)
  await l2_uniswapWrapper
    .connect(transfer.sender)
    .swapAndSend(
      transfer.chainId,
      await transfer.recipient.getAddress(),
      transfer.amount,
      transfer.bonderFee,
      transfer.amountOutMin,
      transfer.deadline,
      transfer.destinationAmountOutMin,
      transfer.destinationDeadline
    )

  // Validate state after transaction
  await expectBalanceOf(
    l2_canonicalToken,
    transfer.sender,
    senderBalanceBefore.sub(transfer.amount)
  )

  const transferNonce = await getTransferNonceFromEvent(l2_bridge)
  const transferAfterSlippage: Transfer = Object.assign(transfer, {
    amount: expectedAmountAfterSlippage
  })
  const isSwapAndSend: boolean = true
  const expectedPendingTransferHash: Buffer = await transferAfterSlippage.getTransferId(transferNonce, isSwapAndSend)

  const pendingAmount = await l2_bridge.pendingAmountForChainId(
    transfer.chainId
  )
  const expectedPendingAmount = transfer.amount
  expect(pendingAmount).to.eq(expectedPendingAmount)
  const transfersSentEvent = (
    await l2_bridge.queryFilter(l2_bridge.filters.TransferSent())
  )[0]
  const transferSentArgs = transfersSentEvent.args
  expect(transferSentArgs[0]).to.eq(
    '0x' + expectedPendingTransferHash.toString('hex')
  )
  expect(transferSentArgs[1]).to.eq(await transfer.recipient.getAddress())
  expect(transferSentArgs[2]).to.eq(transferAfterSlippage.amount)
  expect(transferSentArgs[3]).to.eq(transferNonce)
  expect(transferSentArgs[4]).to.eq(transfer.bonderFee)
}

export const executeL2BridgeCommitTransfers = async (
  l2_bridge: Contract,
  transfer: Transfer,
  bonder: Signer,
  expectedTransferIndex: BigNumber = BigNumber.from('0')
) => {
  // Get state before transaction
  const transferNonce = await getTransferNonceFromEvent(l2_bridge, expectedTransferIndex)
  const pendingTransferIdsForChainId: string = await l2_bridge.pendingTransferIdsForChainId(transfer.chainId, 0)
  const expectedPendingTransferIdsForChainId: string = await transfer.getTransferIdHex(transferNonce)
  expect(pendingTransferIdsForChainId).to.eq(expectedPendingTransferIdsForChainId)
  let pendingAmountForChainId = await l2_bridge.pendingAmountForChainId(
    transfer.chainId
  )
  expect(pendingAmountForChainId).to.eq(transfer.amount)

  // Perform transaction
  await l2_bridge
    .connect(bonder)
    .commitTransfers(transfer.chainId)

  // Validate state after transaction
  const lastCommitTimeForChainId: BigNumber = await l2_bridge.lastCommitTimeForChainId(transfer.chainId)
  const currentTime: number = Math.floor(Date.now() / 1000)
  expect(lastCommitTimeForChainId.toNumber()).to.be.closeTo(
    currentTime,
    TIMESTAMP_VARIANCE
  )
  const expectedErrorMsg: string = 'VM Exception while processing transaction: invalid opcode'
  try {
    await l2_bridge.pendingTransferIdsForChainId(transfer.chainId, 0)
    throw new Error('There should not be a pending transfer ID for chainId in this slot.')
  } catch (err) {
    expect(err.message).to.eq(expectedErrorMsg)
  }

  // Verify state post-transaction
  pendingAmountForChainId = await l2_bridge.pendingAmountForChainId(
    transfer.chainId
  )
  expect(pendingAmountForChainId).to.eq(transfer.amount)

  const expectedMerkleTree = new MerkleTree([await transfer.getTransferId(transferNonce)])

  const transfersCommittedEvent = (
    await l2_bridge.queryFilter(l2_bridge.filters.TransfersCommitted())
  )[expectedTransferIndex.toNumber()]
  const transfersCommittedArgs = transfersCommittedEvent.args
  expect(transfersCommittedArgs[0]).to.eq(expectedMerkleTree.getHexRoot())
  const pendingChainAmounts = transfersCommittedArgs[1]
  expect(pendingChainAmounts).to.eq(transfer.amount)
}

export const executeL2BridgeBondWithdrawalAndDistribute = async (
  l2_bridgeOrigin: Contract,
  l2_hopBridgeToken: Contract,
  l2_bridge: Contract,
  l2_canonicalToken: Contract,
  l2_uniswapRouter: Contract,
  transfer: Transfer,
  bonder: Signer,
  actualTransferAmount: BigNumber,
  expectedTransferIndex: BigNumber = BigNumber.from('0')
) => {
  // Get state before transaction
  const transferNonce = await getTransferNonceFromEvent(l2_bridgeOrigin, expectedTransferIndex)
  const bonderBalanceBefore: BigNumber = await l2_hopBridgeToken.balanceOf(await bonder.getAddress())

  const expectedAmountsRecipientBridge: BigNumber[] = await l2_uniswapRouter.getAmountsOut(
    actualTransferAmount.sub(transfer.bonderFee),
    [l2_canonicalToken.address, l2_hopBridgeToken.address]
  )
  const expectedRecipientAmountAfterSlippage: BigNumber = expectedAmountsRecipientBridge[1]

  // Perform transaction
  await l2_bridge
    .connect(bonder)
    .bondWithdrawalAndDistribute(
      await transfer.recipient.getAddress(),
      transfer.amount,
      transferNonce,
      transfer.bonderFee,
      transfer.amountOutMin,
      transfer.deadline
    )

  // Validate state after transaction
  await expectBalanceOf(
    l2_hopBridgeToken,
    transfer.recipient,
    0
  )
  await expectBalanceOf(
    l2_hopBridgeToken,
    bonder,
    bonderBalanceBefore.add(transfer.bonderFee)
  )
  await expectBalanceOf(
    l2_canonicalToken,
    transfer.recipient,
    expectedRecipientAmountAfterSlippage
  )
}

/**
 * Canonical Bridge Messages
 */

export const getSetL1BridgeAddressMessage = (
  l1_bridge: Contract | string
) => {
  const address = getAddressFromContractOrString(l1_bridge)
  const ABI = [ "function setL1BridgeAddress(address _l1BridgeAddress)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setL1BridgeAddress", [ address ])
}

export const getSetL1MessengerWrapperAddressMessage = (
  l1_messengerWrapper: Contract | string
) => {
  const address = getAddressFromContractOrString(l1_messengerWrapper)
  const ABI = [ "function setL1MessengerWrapperAddress(address _l1MessengerWrapperAddress)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setL1MessengerWrapperAddress", [ address ])
}

export const getSetUniswapWrapperAddressMessage = (
  l2_uniswapWrapper: Contract | string
) => {
  const address = getAddressFromContractOrString(l2_uniswapWrapper)
  const ABI = [ "function setUniswapWrapper(address _uniswapWrapper)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setUniswapWrapper", [ address ])
}

export const getSetMessengerGasLimitMessage = (
  messengerGasLimit: BigNumber
) => {
  const ABI = [ "function setMessengerGasLimit(uint256 _messengerGasLimit)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setMessengerGasLimit", [ messengerGasLimit ])
}

export const getSetHopBridgeTokenOwnerMessage = (
  newOwnerAddress: string
) => {
  const ABI = [ "function setHopBridgeTokenOwner(address newOwner)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setHopBridgeTokenOwner", [ newOwnerAddress ])
}

export const getAddSupportedChainIdsMessage = (
  chainIds: BigNumber[]
) => {
  const ABI = [ "function addSupportedChainIds(uint256[] calldata chainIds)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("addSupportedChainIds", [ chainIds ])
}

export const getRemoveSupportedChainIdsMessage = (
  chainIds: BigNumber[]
) => {
  const ABI = [ "function removeSupportedChainIds(uint256[] calldata chainIds)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("removeSupportedChainIds", [ chainIds ])
}

export const getSetMaxPendingTransfersMessage = (
  maxPendingTransfers: BigNumber
) => {
  const ABI = [ "function setMaxPendingTransfers(uint256 _maxPendingTransfers)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setMaxPendingTransfers", [ maxPendingTransfers ])
}

export const getSetMinimumForceCommitDelayMessage = (
  minimumForceCommitDelay: BigNumber
) => {
  const ABI = [ "function setMinimumForceCommitDelay(uint256 _minimumForceCommitDelay)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setMinimumForceCommitDelay", [ minimumForceCommitDelay ])
}

export const getSetMinimumBonderFeeRequirementsMessage = (
  minBonderBps: BigNumber,
  minBonderFeeAbsolute: BigNumber
) => {
  const ABI = [ "function setMinimumBonderFeeRequirements(uint256 _minBonderBps, uint256 _minBonderFeeAbsolute)" ];
  const ethersInterface = new ethersUtils.Interface(ABI);
  return ethersInterface.encodeFunctionData("setMinimumBonderFeeRequirements", [ minBonderBps, minBonderFeeAbsolute ])
}

const getAddressFromContractOrString = (input: Contract | string): string => {
  if (typeof input === 'string') {
    return input
  } else {
    return input.address
  }
}

// TODO: Move this to utils
export class L2Call {
  public maxGas: BigNumber
  public gasPriceBid: BigNumber
  public destAddress: string
  public calldata: string
  public kind: L2MessageCode.Call

  constructor(
    maxGas: BigNumberish | undefined,
    gasPriceBid: BigNumberish | undefined,
    destAddress: BytesLike | undefined,
    calldata: BytesLike | undefined
  ) {
    if (!maxGas) {
      maxGas = 0
    }
    if (!gasPriceBid) {
      gasPriceBid = 0
    }
    if (!destAddress) {
      destAddress = ethersUtils.hexZeroPad('0x', 20)
    }
    if (!calldata) {
      calldata = '0x'
    }
    this.maxGas = BigNumber.from(maxGas)
    this.gasPriceBid = BigNumber.from(gasPriceBid)
    this.destAddress = ethersUtils.hexlify(destAddress)
    this.calldata = ethersUtils.hexlify(calldata)
    this.kind = L2MessageCode.Call
  }

  static fromData(data: BytesLike): L2Call {
    const bytes = ethersUtils.arrayify(data)
    return new L2Call(
      bytes.slice(0, 32),
      bytes.slice(32, 64),
      bytes.slice(64, 96),
      bytes.slice(96)
    )
  }

  asData(): Uint8Array {
    return ethersUtils.concat([
      hex32(this.maxGas),
      hex32(this.gasPriceBid),
      encodedAddress(this.destAddress),
      this.calldata,
    ])
  }
}
export enum L2MessageCode {
  Transaction = 0,
  ContractTransaction = 1,
  Call = 2,
  TransactionBatch = 3,
  SignedTransaction = 4,
}

const hex32 = (val: BigNumber): Uint8Array => {
  return ethersUtils.zeroPad(ethersUtils.arrayify(val), 32)
}

const encodedAddress = (addr: BytesLike): Uint8Array => {
  return ethersUtils.zeroPad(ethersUtils.arrayify(addr), 32)
}

const getArbitrumMessageParams = (l2_bridge: Contract, message: string) => {
  const tx: L2Call = new L2Call(
    BigNumber.from('2000000'),
    BigNumber.from('2000000'),
    l2_bridge.address,
    message
  )

  return [
    ARB_CHAIN_ADDRESS,
    tx.asData()
  ]
} 