import { BigNumber, constants, utils } from 'ethers';
import {
  API_ETH_MOCK_ADDRESS,
  commonContractAddressBetweenMarketsV2,
  DEFAULT_APPROVE_AMOUNT,
  MAX_UINT_AMOUNT,
  distinctContractAddressBetweenMarketsV2,
  SURPLUS,
} from '../../config';
import { ILendingPool, ILendingPool__factory } from '../../contract-types';
import IERC20ServiceInterface from '../../interfaces/ERC20';
import SynthetixInterface from '../../interfaces/Synthetix';
import LendingPoolInterface from '../../interfaces/v2/LendingPool';
import {
  Configuration,
  eEthereumTxType,
  EthereumTransactionTypeExtended,
  InterestRate,
  Market,
  ProtocolAction,
  TokenMetadataType,
  transactionType,
  tStringDecimalUnits,
} from '../../types';
import { getTxValue, parseNumber } from '../../utils/parsings';
import { LPValidator } from '../../validators/methodValidators';
import {
  LPBorrowParamsType,
  LPDepositParamsType,
  LPLiquidationCall,
  LPRepayParamsType,
  LPRepayWithCollateral,
  LPSetUsageAsCollateral,
  LPSwapBorrowRateMode,
  LPSwapCollateral,
  LPWithdrawParamsType,
  LPFlashLiquidation,
} from '../../types/LendingPoolMethodTypes';
import WETHGatewayInterface from '../../interfaces/WETHGateway';
import {
  IsEthAddress,
  IsPositiveAmount,
  IsPositiveOrMinusOneAmount,
} from '../../validators/paramValidators';
import LiquiditySwapAdapterInterface from '../../interfaces/LiquiditySwapAdapter';
import RepayWithCollateralAdapterInterface from '../../interfaces/RepayWithCollateralAdapter';
import BaseService from '../BaseService';

export default class LendingPool
  extends BaseService<ILendingPool>
  implements LendingPoolInterface {
  readonly market: Market;

  readonly erc20Service: IERC20ServiceInterface;

  readonly lendingPoolAddress: string;

  readonly synthetixService: SynthetixInterface;

  readonly wethGatewayService: WETHGatewayInterface;

  readonly liquiditySwapAdapterService: LiquiditySwapAdapterInterface;

  readonly repayWithCollateralAdapterService: RepayWithCollateralAdapterInterface;

  constructor(
    config: Configuration,
    erc20Service: IERC20ServiceInterface,
    synthetixService: SynthetixInterface,
    wethGatewayService: WETHGatewayInterface,
    liquiditySwapAdapterService: LiquiditySwapAdapterInterface,
    repayWithCollateralAdapterService: RepayWithCollateralAdapterInterface,
    market: Market
  ) {
    super(config, ILendingPool__factory);
    this.erc20Service = erc20Service;
    this.synthetixService = synthetixService;
    this.wethGatewayService = wethGatewayService;
    this.liquiditySwapAdapterService = liquiditySwapAdapterService;
    this.repayWithCollateralAdapterService = repayWithCollateralAdapterService;
    this.market = market;

    const { network } = this.config;
    this.lendingPoolAddress =
      distinctContractAddressBetweenMarketsV2[this.market][
        network
      ].LENDINGPOOL_ADDRESS;
  }

  @LPValidator
  public async deposit(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    @IsPositiveAmount('amount')
    @IsEthAddress('onBehalfOf')
    { user, reserve, amount, onBehalfOf, referralCode }: LPDepositParamsType
  ): Promise<EthereumTransactionTypeExtended[]> {
    if (reserve.toLowerCase() === API_ETH_MOCK_ADDRESS.toLowerCase()) {
      return this.wethGatewayService.depositETH({
        lendingPool: this.lendingPoolAddress,
        user,
        amount,
        onBehalfOf,
        referralCode,
      });
    }
    const {
      isApproved,
      approve,
      decimalsOf,
    }: IERC20ServiceInterface = this.erc20Service;
    const txs: EthereumTransactionTypeExtended[] = [];
    const reserveDecimals: number = await decimalsOf(reserve);
    const convertedAmount: tStringDecimalUnits = parseNumber(
      amount,
      reserveDecimals
    );

    const fundsAvailable: boolean = await this.synthetixService.synthetixValidation(
      user,
      reserve,
      convertedAmount
    );
    if (!fundsAvailable) {
      throw new Error('Not enough funds to execute operation');
    }

    const approved = await isApproved(
      reserve,
      user,
      this.lendingPoolAddress,
      amount
    );
    if (!approved) {
      const approveTx: EthereumTransactionTypeExtended = approve(
        user,
        reserve,
        this.lendingPoolAddress,
        DEFAULT_APPROVE_AMOUNT
      );
      txs.push(approveTx);
    }

    const lendingPoolContract: ILendingPool = this.getContractInstance(
      this.lendingPoolAddress
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.deposit(
          reserve,
          convertedAmount,
          onBehalfOf || user,
          referralCode || '0'
        ),
      from: user,
      value: getTxValue(reserve, convertedAmount),
    });

    txs.push({
      tx: txCallback,
      txType: eEthereumTxType.DLP_ACTION,
      gas: this.generateTxPriceEstimation(
        txs,
        txCallback,
        ProtocolAction.deposit
      ),
    });

    return txs;
  }

  @LPValidator
  public async withdraw(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    @IsPositiveOrMinusOneAmount('amount')
    @IsEthAddress('onBehalfOf')
    @IsEthAddress('aTokenAddress')
    { user, reserve, amount, onBehalfOf, aTokenAddress }: LPWithdrawParamsType
  ): Promise<EthereumTransactionTypeExtended[]> {
    if (reserve.toLowerCase() === API_ETH_MOCK_ADDRESS.toLowerCase()) {
      if (!aTokenAddress) {
        throw new Error(
          'To withdraw ETH you need to pass the aWETH token address'
        );
      }

      return this.wethGatewayService.withdrawETH({
        lendingPool: this.lendingPoolAddress,
        user,
        amount,
        onBehalfOf,
        aTokenAddress,
      });
    }
    const { decimalsOf }: IERC20ServiceInterface = this.erc20Service;
    const decimals: number = await decimalsOf(reserve);

    const convertedAmount: tStringDecimalUnits =
      amount === '-1'
        ? constants.MaxUint256.toString()
        : parseNumber(amount, decimals);

    const lendingPoolContract: ILendingPool = this.getContractInstance(
      this.lendingPoolAddress
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.withdraw(
          reserve,
          convertedAmount,
          onBehalfOf || user
        ),
      from: user,
      action: ProtocolAction.withdraw,
    });

    return [
      {
        tx: txCallback,
        txType: eEthereumTxType.DLP_ACTION,
        gas: this.generateTxPriceEstimation(
          [],
          txCallback,
          ProtocolAction.withdraw
        ),
      },
    ];
  }

  @LPValidator
  public async borrow(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    @IsPositiveAmount('amount')
    @IsEthAddress('debtTokenAddress')
    @IsEthAddress('onBehalfOf')
    {
      user,
      reserve,
      amount,
      interestRateMode,
      debtTokenAddress,
      onBehalfOf,
      referralCode,
    }: LPBorrowParamsType
  ): Promise<EthereumTransactionTypeExtended[]> {
    if (reserve.toLowerCase() === API_ETH_MOCK_ADDRESS.toLowerCase()) {
      if (!debtTokenAddress) {
        throw new Error(
          `To borrow ETH you need to pass the stable or variable WETH debt Token Address corresponding the interestRateMode`
        );
      }
      return this.wethGatewayService.borrowETH({
        lendingPool: this.lendingPoolAddress,
        user,
        amount,
        debtTokenAddress,
        interestRateMode,
        referralCode,
      });
    }
    const { decimalsOf }: IERC20ServiceInterface = this.erc20Service;
    const reserveDecimals = await decimalsOf(reserve);
    const formatAmount: tStringDecimalUnits = parseNumber(
      amount,
      reserveDecimals
    );

    const numericRateMode = interestRateMode === InterestRate.Variable ? 2 : 1;

    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.borrow(
          reserve,
          formatAmount,
          numericRateMode,
          referralCode || 0,
          onBehalfOf || user
        ),
      from: user,
    });

    return [
      {
        tx: txCallback,
        txType: eEthereumTxType.DLP_ACTION,
        gas: this.generateTxPriceEstimation([], txCallback),
      },
    ];
  }

  @LPValidator
  public async repay(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    @IsPositiveOrMinusOneAmount('amount')
    @IsEthAddress('onBehalfOf')
    { user, reserve, amount, interestRateMode, onBehalfOf }: LPRepayParamsType
  ): Promise<EthereumTransactionTypeExtended[]> {
    if (reserve.toLowerCase() === API_ETH_MOCK_ADDRESS.toLowerCase()) {
      return this.wethGatewayService.repayETH({
        lendingPool: this.lendingPoolAddress,
        user,
        amount,
        interestRateMode,
        onBehalfOf,
      });
    }
    const txs: EthereumTransactionTypeExtended[] = [];
    const {
      isApproved,
      approve,
      decimalsOf,
    }: IERC20ServiceInterface = this.erc20Service;

    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );
    const { populateTransaction }: ILendingPool = lendingPoolContract;
    const numericRateMode = interestRateMode === InterestRate.Variable ? 2 : 1;
    const decimals: number = await decimalsOf(reserve);

    const convertedAmount: tStringDecimalUnits =
      amount === '-1'
        ? constants.MaxUint256.toString()
        : parseNumber(amount, decimals);

    if (amount !== '-1') {
      const fundsAvailable: boolean = await this.synthetixService.synthetixValidation(
        user,
        reserve,
        convertedAmount
      );
      if (!fundsAvailable) {
        throw new Error('Not enough funds to execute operation');
      }
    }

    const approved: boolean = await isApproved(
      reserve,
      user,
      this.lendingPoolAddress,
      amount
    );

    if (!approved) {
      const approveTx: EthereumTransactionTypeExtended = approve(
        user,
        reserve,
        this.lendingPoolAddress,
        DEFAULT_APPROVE_AMOUNT
      );
      txs.push(approveTx);
    }

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        populateTransaction.repay(
          reserve,
          convertedAmount,
          numericRateMode,
          onBehalfOf || user
        ),
      from: user,
      value: getTxValue(reserve, convertedAmount),
    });

    txs.push({
      tx: txCallback,
      txType: eEthereumTxType.DLP_ACTION,
      gas: this.generateTxPriceEstimation(
        txs,
        txCallback,
        ProtocolAction.repay
      ),
    });

    return txs;
  }

  @LPValidator
  public async swapBorrowRateMode(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    { user, reserve, interestRateMode }: LPSwapBorrowRateMode
  ): Promise<EthereumTransactionTypeExtended[]> {
    const numericRateMode = interestRateMode === InterestRate.Variable ? 2 : 1;

    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );
    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.swapBorrowRateMode(
          reserve,
          numericRateMode
        ),
      from: user,
    });

    return [
      {
        txType: eEthereumTxType.DLP_ACTION,
        tx: txCallback,
        gas: this.generateTxPriceEstimation([], txCallback),
      },
    ];
  }

  @LPValidator
  public async setUsageAsCollateral(
    @IsEthAddress('user')
    @IsEthAddress('reserve')
    { user, reserve, usageAsCollateral }: LPSetUsageAsCollateral
  ): Promise<EthereumTransactionTypeExtended[]> {
    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.setUserUseReserveAsCollateral(
          reserve,
          usageAsCollateral
        ),
      from: user,
    });

    return [
      {
        tx: txCallback,
        txType: eEthereumTxType.DLP_ACTION,
        gas: this.generateTxPriceEstimation([], txCallback),
      },
    ];
  }

  @LPValidator
  public async liquidationCall(
    @IsEthAddress('liquidator')
    @IsEthAddress('liquidatedUser')
    @IsEthAddress('debtReserve')
    @IsEthAddress('collateralReserve')
    @IsPositiveAmount('purchaseAmount')
    {
      liquidator,
      liquidatedUser,
      debtReserve,
      collateralReserve,
      purchaseAmount,
      getAToken,
      liquidateAll,
    }: LPLiquidationCall
  ): Promise<EthereumTransactionTypeExtended[]> {
    const txs: EthereumTransactionTypeExtended[] = [];
    const {
      isApproved,
      approve,
      getTokenData,
    }: IERC20ServiceInterface = this.erc20Service;

    const approved = await isApproved(
      debtReserve,
      liquidator,
      this.lendingPoolAddress,
      purchaseAmount
    );

    if (!approved) {
      const approveTx: EthereumTransactionTypeExtended = approve(
        liquidator,
        debtReserve,
        this.lendingPoolAddress,
        DEFAULT_APPROVE_AMOUNT
      );

      txs.push(approveTx);
    }

    const [debtReserveInfo]: TokenMetadataType[] = await Promise.all([
      getTokenData(debtReserve),
    ]);

    const reserveDecimals: number = debtReserveInfo.decimals;

    const convertedAmount: tStringDecimalUnits = liquidateAll
      ? MAX_UINT_AMOUNT
      : parseNumber(purchaseAmount, reserveDecimals);

    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.liquidationCall(
          collateralReserve,
          debtReserve,
          liquidatedUser,
          convertedAmount,
          getAToken || false
        ),
      from: liquidator,
      value: getTxValue(debtReserve, convertedAmount),
    });

    txs.push({
      tx: txCallback,
      txType: eEthereumTxType.DLP_ACTION,
      gas: this.generateTxPriceEstimation(
        txs,
        txCallback,
        ProtocolAction.liquidationCall
      ),
    });

    return txs;
  }

  @LPValidator
  public async swapCollateral(
    @IsEthAddress('user')
    @IsEthAddress('fromAsset')
    @IsEthAddress('fromAToken')
    @IsEthAddress('toAsset')
    @IsEthAddress('onBehalfOf')
    @IsPositiveAmount('fromAmount')
    @IsPositiveAmount('toAmount')
    {
      user,
      flash,
      fromAsset,
      fromAToken,
      toAsset,
      fromAmount,
      toAmount,
      maxSlippage,
      permitSignature,
      swapAll,
      onBehalfOf,
      referralCode,
      useEthPath,
    }: LPSwapCollateral
  ): Promise<EthereumTransactionTypeExtended[]> {
    const txs: EthereumTransactionTypeExtended[] = [];

    const permitParams = permitSignature || {
      amount: '0',
      deadline: '0',
      v: 0,
      r: '0x0000000000000000000000000000000000000000000000000000000000000000',
      s: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    const { SWAP_COLLATERAL_ADAPTER } = commonContractAddressBetweenMarketsV2[
      this.config.network
    ];

    const approved: boolean = await this.erc20Service.isApproved(
      fromAToken,
      user,
      SWAP_COLLATERAL_ADAPTER,
      fromAmount
    );

    if (!approved) {
      const approveTx: EthereumTransactionTypeExtended = this.erc20Service.approve(
        user,
        fromAToken,
        SWAP_COLLATERAL_ADAPTER,
        constants.MaxUint256.toString()
      );

      txs.push(approveTx);
    }

    const tokenDecimals: number = await this.erc20Service.decimalsOf(fromAsset);

    const convertedAmount: string = parseNumber(fromAmount, tokenDecimals);

    const tokenToDecimals: number = await this.erc20Service.decimalsOf(toAsset);

    const amountSlippage = (
      Number(toAmount) -
      (Number(toAmount) * Number(maxSlippage)) / 100
    ).toString();

    const amountSlippageConverted: string = parseNumber(
      amountSlippage,
      tokenToDecimals
    );

    const lendingPoolContract = this.getContractInstance(
      this.lendingPoolAddress
    );

    if (flash) {
      const FLASHLOAN_PREMIUM_TOTAL: BigNumber = await lendingPoolContract.FLASHLOAN_PREMIUM_TOTAL();
      const convertedAmountNoFees: string = BigNumber.from(convertedAmount)
        .sub(
          BigNumber.from(convertedAmount)
            .mul(FLASHLOAN_PREMIUM_TOTAL)
            .div(10000)
        )
        .toString();

      const amountWithSurplus: string = (
        Number(fromAmount) +
        (Number(fromAmount) * Number(SURPLUS)) / 100
      ).toString();

      const convertedAmountWithSurplus: string = parseNumber(
        amountWithSurplus,
        tokenDecimals
      );

      const params: string = utils.defaultAbiCoder.encode(
        [
          'address[]',
          'uint256[]',
          'bool[]',
          'uint256[]',
          'uint256[]',
          'uint8[]',
          'bytes32[]',
          'bytes32[]',
          'bool[]',
        ],
        [
          [toAsset],
          [amountSlippageConverted],
          [swapAll],
          [permitParams.amount],
          [permitParams.deadline],
          [permitParams.v],
          [permitParams.r],
          [permitParams.s],
          [useEthPath || false],
        ]
      );

      const txCallback: () => Promise<transactionType> = this.generateTxCallback(
        {
          rawTxMethod: () =>
            lendingPoolContract.populateTransaction.flashLoan(
              SWAP_COLLATERAL_ADAPTER,
              [fromAsset],
              swapAll ? [convertedAmountWithSurplus] : [convertedAmountNoFees],
              [0], // interest rate mode to NONE for flashloan to not open debt
              onBehalfOf || user,
              params,
              referralCode || '0'
            ),
          from: user,
        }
      );

      txs.push({
        tx: txCallback,
        txType: eEthereumTxType.DLP_ACTION,
        gas: this.generateTxPriceEstimation(
          txs,
          txCallback,
          ProtocolAction.swapCollateral
        ),
      });
      return txs;
    }

    // Direct call to swap and deposit
    const swapAndDepositTx: EthereumTransactionTypeExtended = await this.liquiditySwapAdapterService.swapAndDeposit(
      {
        user,
        assetToSwapFrom: fromAsset,
        assetToSwapTo: toAsset,
        amountToSwap: swapAll
          ? constants.MaxUint256.toString()
          : convertedAmount,
        minAmountToReceive: amountSlippageConverted,
        permitParams,
        useEthPath,
      }
    );

    txs.push(swapAndDepositTx);
    return txs;
  }

  @LPValidator
  public async repayWithCollateral(
    @IsEthAddress('user')
    @IsEthAddress('fromAsset')
    @IsEthAddress('fromAToken')
    @IsEthAddress('assetToRepay')
    @IsEthAddress('onBehalfOf')
    @IsPositiveAmount('repayWithAmount')
    @IsPositiveAmount('repayAmount')
    {
      user,
      fromAsset,
      fromAToken,
      assetToRepay,
      repayWithAmount,
      repayAmount,
      permitSignature,
      repayAllDebt,
      rateMode,
      onBehalfOf,
      referralCode,
      flash,
      useEthPath,
    }: LPRepayWithCollateral
  ): Promise<EthereumTransactionTypeExtended[]> {
    const txs: EthereumTransactionTypeExtended[] = [];

    const permitParams = permitSignature || {
      amount: '0',
      deadline: '0',
      v: 0,
      r: '0x0000000000000000000000000000000000000000000000000000000000000000',
      s: '0x0000000000000000000000000000000000000000000000000000000000000000',
    };

    const {
      REPAY_WITH_COLLATERAL_ADAPTER,
    } = commonContractAddressBetweenMarketsV2[this.config.network];

    const approved: boolean = await this.erc20Service.isApproved(
      fromAToken,
      user,
      REPAY_WITH_COLLATERAL_ADAPTER,
      repayWithAmount
    );

    if (!approved) {
      const approveTx: EthereumTransactionTypeExtended = this.erc20Service.approve(
        user,
        fromAToken,
        REPAY_WITH_COLLATERAL_ADAPTER,
        constants.MaxUint256.toString()
      );

      txs.push(approveTx);
    }

    const fromDecimals: number = await this.erc20Service.decimalsOf(fromAsset);
    const convertedRepayWithAmount: string = parseNumber(
      repayWithAmount,
      fromDecimals
    );

    const repayAmountWithSurplus: string = (
      Number(repayAmount) +
      (Number(repayAmount) * Number(SURPLUS)) / 100
    ).toString();

    const decimals: number = await this.erc20Service.decimalsOf(assetToRepay);
    const convertedRepayAmount: string = repayAllDebt
      ? parseNumber(repayAmountWithSurplus, decimals)
      : parseNumber(repayAmount, decimals);

    let numericInterestRate = 0;
    if (rateMode) {
      numericInterestRate = rateMode === InterestRate.Stable ? 1 : 2;
    }

    if (flash) {
      const params: string = utils.defaultAbiCoder.encode(
        [
          'address',
          'uint256',
          'uint256',
          'uint256',
          'uint256',
          'uint8',
          'bytes32',
          'bytes32',
          'bool',
        ],
        [
          fromAsset,
          convertedRepayWithAmount,
          numericInterestRate,
          permitParams.amount,
          permitParams.deadline,
          permitParams.v,
          permitParams.r,
          permitParams.s,
          useEthPath || false,
        ]
      );

      const lendingPoolContract = this.getContractInstance(
        this.lendingPoolAddress
      );

      const txCallback: () => Promise<transactionType> = this.generateTxCallback(
        {
          rawTxMethod: () =>
            lendingPoolContract.populateTransaction.flashLoan(
              REPAY_WITH_COLLATERAL_ADAPTER,
              [assetToRepay],
              [convertedRepayAmount],
              [0], // interest rate mode to NONE for flashloan to not open debt
              onBehalfOf || user,
              params,
              referralCode || '0'
            ),
          from: user,
        }
      );

      txs.push({
        tx: txCallback,
        txType: eEthereumTxType.DLP_ACTION,
        gas: this.generateTxPriceEstimation(
          txs,
          txCallback,
          ProtocolAction.repayCollateral
        ),
      });

      return txs;
    }

    const swapAndRepayTx: EthereumTransactionTypeExtended = this.repayWithCollateralAdapterService.swapAndRepay(
      {
        user,
        collateralAsset: fromAsset,
        debtAsset: assetToRepay,
        collateralAmount: convertedRepayWithAmount,
        debtRepayAmount: convertedRepayAmount,
        debtRateMode: numericInterestRate,
        permit: permitParams,
        useEthPath,
      }
    );

    txs.push(swapAndRepayTx);

    return txs;
  }

  @LPValidator
  public async flashLiquidation(
    @IsEthAddress('user')
    @IsEthAddress('collateralAsset')
    @IsEthAddress('borrowedAsset')
    @IsPositiveAmount('debtTokenCover')
    @IsEthAddress('initiator')
    {
      user,
      collateralAsset,
      borrowedAsset,
      debtTokenCover,
      liquidateAll,
      initiator,
      useEthPath,
    }: LPFlashLiquidation
  ): Promise<EthereumTransactionTypeExtended[]> {
    const addSurplus = (amount: string): string => {
      return (
        Number(amount) +
        (Number(amount) * Number(amount)) / 100
      ).toString();
    };

    const txs: EthereumTransactionTypeExtended[] = [];

    const { FLASHLIQUIDATION } = commonContractAddressBetweenMarketsV2[
      this.config.network
    ];

    const lendingPoolContract: ILendingPool = this.getContractInstance(
      this.lendingPoolAddress
    );

    const tokenDecimals: number = await this.erc20Service.decimalsOf(
      borrowedAsset
    );

    const convertedDebt = parseNumber(debtTokenCover, tokenDecimals);

    const convertedDebtTokenCover: string = liquidateAll
      ? constants.MaxUint256.toString()
      : convertedDebt;

    const flashBorrowAmount = liquidateAll
      ? parseNumber(addSurplus(debtTokenCover), tokenDecimals)
      : convertedDebt;

    const params: string = utils.defaultAbiCoder.encode(
      ['address', 'address', 'address', 'uint256', 'bool'],
      [
        collateralAsset,
        borrowedAsset,
        user,
        convertedDebtTokenCover,
        useEthPath || false,
      ]
    );

    const txCallback: () => Promise<transactionType> = this.generateTxCallback({
      rawTxMethod: () =>
        lendingPoolContract.populateTransaction.flashLoan(
          FLASHLIQUIDATION,
          [borrowedAsset],
          [flashBorrowAmount],
          [0],
          initiator,
          params,
          '0'
        ),
      from: initiator,
    });

    txs.push({
      tx: txCallback,
      txType: eEthereumTxType.DLP_ACTION,
      gas: this.generateTxPriceEstimation(
        txs,
        txCallback,
        ProtocolAction.liquidationFlash
      ),
    });
    return txs;
  }
}
