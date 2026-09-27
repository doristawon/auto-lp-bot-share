import { AbiCoder, Interface, JsonRpcProvider } from 'ethers';

const hash = process.argv[2] || process.env.TX_HASH;
if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('transaction hash required');
const rpc = new JsonRpcProvider(process.env.RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com');
const tx = await rpc.getTransaction(hash);
if (!tx) throw new Error('transaction unavailable: ' + hash);

const router = new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
let decoded;
try { decoded = router.decodeFunctionData('execute', tx.data); }
catch { throw new Error('transaction is not execute(bytes,bytes[],uint256): ' + tx.data.slice(0, 10)); }

const commands = bytesList(decoded[0]);
const inputs = [...decoded[1]];
const coder = AbiCoder.defaultAbiCoder();
const COMMANDS = {
  0x00:'V3_SWAP_EXACT_IN',0x01:'V3_SWAP_EXACT_OUT',0x02:'PERMIT2_TRANSFER_FROM',
  0x03:'PERMIT2_PERMIT_BATCH',0x04:'SWEEP',0x05:'TRANSFER',0x06:'PAY_PORTION',
  0x08:'V2_SWAP_EXACT_IN',0x09:'V2_SWAP_EXACT_OUT',0x0a:'PERMIT2_PERMIT',
  0x0b:'WRAP_ETH',0x0c:'UNWRAP_WETH',0x0d:'PERMIT2_TRANSFER_FROM_BATCH',
  0x0e:'BALANCE_CHECK_ERC20',0x0f:'UNWRAP_WETH_EXACT',0x10:'V4_SWAP',
  0x11:'V3_POSITION_MANAGER_PERMIT',0x12:'V3_POSITION_MANAGER_CALL',
  0x13:'V4_INITIALIZE_POOL',0x14:'V4_POSITION_MANAGER_CALL',0x21:'EXECUTE_SUB_PLAN'
};
const ACTIONS = {
  0x06:'SWAP_EXACT_IN_SINGLE',0x07:'SWAP_EXACT_IN',0x08:'SWAP_EXACT_OUT_SINGLE',
  0x09:'SWAP_EXACT_OUT',0x0b:'SETTLE',0x0c:'SETTLE_ALL',0x0d:'SETTLE_PAIR',
  0x0e:'TAKE',0x0f:'TAKE_ALL',0x10:'TAKE_PORTION',0x11:'TAKE_PAIR',
  0x12:'CLOSE_CURRENCY',0x13:'CLEAR_OR_TAKE',0x14:'SWEEP',0x15:'WRAP',0x16:'UNWRAP'
};
const EXACT_INPUT_SINGLE='tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 hookDataOffset,bytes hookData)';

const result=[];
for(let i=0;i<commands.length;i++){
  const code=commands[i]&0x7f;
  const item={index:i,raw:'0x'+commands[i].toString(16).padStart(2,'0'),command:COMMANDS[code]||'UNKNOWN',input:inputs[i]};
  if(code===0x10){
    try{
      const [actions,params]=coder.decode(['bytes','bytes[]'],inputs[i]);
      const actionBytes=bytesList(actions);
      item.v4Actions=[];
      for(let j=0;j<actionBytes.length;j++){
        const a=actionBytes[j];
        const action={index:j,raw:'0x'+a.toString(16).padStart(2,'0'),action:ACTIONS[a]||'UNKNOWN',param:params[j]};
        try{
          if(a===0x06){
            const [swap]=coder.decode([EXACT_INPUT_SINGLE],params[j]);
            action.decoded={
              poolKey:{
                currency0:swap.poolKey.currency0,currency1:swap.poolKey.currency1,
                fee:Number(swap.poolKey.fee),tickSpacing:Number(swap.poolKey.tickSpacing),hooks:swap.poolKey.hooks
              },
              zeroForOne:swap.zeroForOne,
              amountIn:swap.amountIn.toString(),
              amountOutMinimum:swap.amountOutMinimum.toString(),
              hookData:swap.hookData
            };
          }else if(a===0x0c||a===0x0f){
            const [currency,amount]=coder.decode(['address','uint256'],params[j]);
            action.decoded={currency,amount:amount.toString()};
          }
        }catch(error){ action.decodeError=error.message; }
        item.v4Actions.push(action);
      }
    }catch(error){item.v4DecodeError=error.message;}
  }
  result.push(item);
}

console.log(JSON.stringify({
  hash,
  from:tx.from,
  to:tx.to,
  selector:tx.data.slice(0,10),
  deadline:decoded[2].toString(),
  commands:result
},null,2));

function bytesList(value){
  const hex=String(value).replace(/^0x/,'');
  const out=[];
  for(let i=0;i<hex.length;i+=2) out.push(parseInt(hex.slice(i,i+2),16));
  return out;
}
