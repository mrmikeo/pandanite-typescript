import { PandaniteCore } from './Core'
import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema, mempoolSchema } from '../models/Model';
import Big from 'big.js';
import { Constants } from "./Constants"
import * as minimist from 'minimist';
import * as WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';
import { createLogger, format, transports } from 'winston';
import * as net from 'net';
import * as http from 'http';

http.globalAgent.maxSockets = 100;

const { combine, timestamp, label, printf } = format;

const myFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = createLogger({
  format: combine(
  	format.colorize(),
    timestamp(),
    myFormat
  ),
  transports: [new transports.Console()]
});

const Transaction = mongoose.model('Transaction', transactionSchema);
const Address = mongoose.model('Address', addressSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Token = mongoose.model('Token', tokenSchema);
const Block = mongoose.model('Block', blockSchema);
const Peer = mongoose.model('Peer', peerSchema);
const Mempool = mongoose.model('Mempool', mempoolSchema);

/***
 * This queue is for downloading the blockchain, but can be used for any purpose that requires a queue with one or more workers
 */
class AsyncQueue {
    private queue: number[];
    private enqueuePromise: Promise<void> | null;
    private enqueueResolve: (() => void) | null;
  
    constructor() {
      this.queue = [];
      this.enqueuePromise = null;
      this.enqueueResolve = null;
    }
  
    enqueue(item: number): Promise<void> {
      return new Promise<void>((resolve) => {
        this.queue.push(item);
        if (this.enqueueResolve) {
          this.enqueueResolve();
        }
        this.enqueueResolve = resolve;
      });
    }

    requeue(item: number): Promise<void> {
        return new Promise<void>((resolve) => {
          this.queue.unshift(item);
          if (this.enqueueResolve) {
            this.enqueueResolve();
          }
          this.enqueueResolve = resolve;
        });
      }

    async dequeue(): Promise<number> {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.enqueueResolve = resolve;
        });
      }
  
      return this.queue.shift()!;
    }

    hasqueue(item: number): boolean {
        if (this.queue.indexOf(item) > -1) return true;
        return false;
    }
    
    isEmpty(): boolean {
      return this.queue.length === 0;
    }
}
  
type Worker = (that: any, hostname: string, item: number) => Promise<void>;

class QueueProcessor {
    private queue: AsyncQueue;
    private workers: Map<string, boolean>;
    private workerFunction: Worker;
  
    constructor(that) {
      this.queue = new AsyncQueue();
      this.workers = new Map<string, boolean>();
      this.workerFunction = this.defaultWorkerFunction;
      this.processQueue(that);
    }
  
    addWorker(hostname: string): void {
      this.workers.set(hostname, false);
    }
  
    addFunction(workerFunction: Worker): void {
      this.workerFunction = workerFunction;
    }
  
    removeWorker(hostname: string): void {
      this.workers.delete(hostname);
    }

    hasWorker(hostname: string): boolean {
        return this.workers.has(hostname);
    }

    async processQueue(that: number): Promise<void> {
        while (true) {
          const availableWorkers = Array.from(this.workers.entries()).filter(
            ([_, isWorking]) => !isWorking
          );
    
          if (availableWorkers.length === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10)); // Wait for available workers
            continue; // No available workers, so skip to next iteration
          }
    
          const item = await this.queue.dequeue(); // Dequeue item
    
          const [hostname] = availableWorkers[Math.floor(Math.random() * availableWorkers.length)]; // Select a random available worker
          this.workers.set(hostname, true); // Mark the worker as busy
    
          this.workerFunction(that, hostname, item).then(() => {
            this.workers.set(hostname, false); // Mark the worker as available again
          });
        }
    }
  
    enqueue(item: number): void {
      if (!this.queue.hasqueue(item))
        this.queue.enqueue(item);
    }

    requeue(item: number): void {
        if (!this.queue.hasqueue(item))
          this.queue.requeue(item);
    }

    hasqueue(item: number): boolean {
        return this.queue.hasqueue(item);
    }

    private defaultWorkerFunction: Worker = async (that: any, thisPeer: string, height: number) => {

        try {

            if (that.peerHeights[thisPeer] >= height)
            {
                // has blocks we can download

                // what version is this peer? can we do ws?
                if (that.websocketPeers[thisPeer])
                {

                    // get block via websocket

                    const messageId = that.stringToHex(thisPeer) + "." + uuidv4();

                    const message = {
                        method: 'getBlock',
                        blockId: height,
                        messageId: messageId
                    };

                    that.wsRespFunc[messageId] = (peer: string, messageId: string, data: string) => {

                        try {

                            const jsonparse = JSON.parse(data);
                            const jsondata = jsonparse.data;

                            if (jsondata && jsondata.hash)
                            {

                                jsondata.receivedFromPeer = peer;

                                that.downloadedBlocks[height] = jsondata;
                                delete that.wsRespFunc[messageId];

                            }
                            else
                            {
                                that.removeActivePeer(peer);
                                delete that.downloadedBlocks[height];
                                that.queueProcessor.requeue(height);
                                delete that.wsRespFunc[messageId];
                            }

                        } catch (e) {


                        }

                    };

                    try {
                        that.websocketPeers[thisPeer].send(JSON.stringify(message));
                    } catch (e) {
                        logger.warn(e);
                        delete that.wsRespFunc[messageId];
                        delete that.websocketPeers[thisPeer];
                    }
                }
                else
                {
                
                    const data: any = await that.getJSONFromURL(thisPeer + "/block?blockId=" + height);
        
                    if (data && data.hash)
                    {
                        data.receivedFromPeer = thisPeer;
                        that.downloadedBlocks[height] = data;
                    }
                    else
                    {
                        delete that.downloadedBlocks[height];
                        that.queueProcessor.removeWorker(thisPeer);
                        that.queueProcessor.requeue(height);
                    }

                }

            }
            else
            {

                delete that.downloadedBlocks[height];
                that.queueProcessor.requeue(height);

            }

        } catch (e) {

            that.removeActivePeer(thisPeer);
            delete that.downloadedBlocks[height];
            that.queueProcessor.removeWorker(thisPeer);
            that.queueProcessor.requeue(height);

        }

        return;

    };




}

export class PandaniteJobs{

    checkingPeers: boolean;
    checkPeerLock: number;
    findingPeers: boolean;
    findPeerLock: number;
    syncingBlocks: boolean;
    syncBlocksLock: number;
    downloadingBlocks: boolean;
    activePeers: Array<string>;
    badPeers: Array<string>;
    currentPeer: string;
    downloadedBlocks: Object;
    peerHeights: Object;
    peerVersions: Object;
    queueProcessor: QueueProcessor;
    myBlockHeight: number;
    difficulty: number;
    websocketPeers: Object;
    wsRespFunc: Object;
    myIpAddress: string;

    constructor() {
        this.activePeers = [];
        this.badPeers = [];
        this.checkingPeers = false;
        this.checkPeerLock = 0;
        this.findingPeers = false;
        this.findPeerLock = 0;
        this.syncingBlocks = false;
        this.syncBlocksLock = 0;
        this.downloadingBlocks = false;
        this.currentPeer = '';
        this.downloadedBlocks = {};
        this.peerHeights = {};
        this.peerVersions = {};
        this.queueProcessor = new QueueProcessor(this);
        this.myBlockHeight = 0;
        this.difficulty = 16;
        this.websocketPeers = {}; // v2 peers only
        this.wsRespFunc = {}; // v2 peers only
        this.myIpAddress = "127.0.0.1";
    }

    public async startBlockchain()  {

        const argv = minimist(process.argv.slice(1));

        if (argv.reset === true) // reset chain
        {
            await Block.deleteMany();
            await Transaction.deleteMany();
            await Balance.deleteMany();
            await Token.deleteMany();
            await Peer.deleteMany();
            logger.warn("Chain is reset");
        }

        if (argv.resetpeers === true) // reset chain
        {
            await Peer.deleteMany();
            logger.warn("Peers is reset");
        }

        const myHeight = await Block.find().sort({height: -1}).limit(1);

        let height = 0;
        if (myHeight.length > 0) height = myHeight[0].height;

        this.myBlockHeight = height;

        if (argv.rollback && parseInt(argv.rollback) > 0)
        {

            for (let i = height; i > height - parseInt(argv.rollback); i--)
            {
                await this.doBlockRollback(i);
            }

        }

        if (argv.revalidate === true)
        {

            // In this case we won't redownload the chain, but instead clear all balances and revalidate from the database records 
            // this will go as far as it can validate.  any invalid will stop and clear any blocks above last valid

            await this.revalidateBlockchain();

            const newHeight = await Block.find().sort({height: -1}).limit(1);
            height = 0;
            if (newHeight.length > 0) height = newHeight[0].height;

        }

        // clear mempool
        await Mempool.deleteMany();

        // get external ip address
        try {
            const body: string = await this.getStringFromURL('http://api.ipify.org/');
            logger.info("My public IP address is: " + body);
            this.myIpAddress = body;
        } catch (e) {}

        const lastDiffHeight = Math.floor(height/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

        logger.info("My block height is " + height);
        logger.info("Last diff height is " + lastDiffHeight);

        await this.updateDifficultyForHeight(lastDiffHeight);

        // start jobs for syncing peers list & blocks

        //this.checkLocks();

        
        // Check Peers Every 20s
        setIntervalAsync(async () => {
            await this.checkPeers();
            await this.printPeeringInfo();
        }, 20000);

        // Find New Peers Every 60s if needed
        setIntervalAsync(async () => {
            if (this.activePeers.length > 0 && this.activePeers.length < globalThis.maxPeers)
            {
                await this.findPeers();
            }
        }, 60000);

        // Download any new blocks every 2s
        setIntervalAsync(async () => {
            await this.downloadBlocks();
        }, 2000);

        // Sync Downloaded Blocks Every 2s
        setIntervalAsync(async () => {
            await this.syncBlocks();
        }, 2000);

    }

    private removeActivePeer (value: string) { 
    
        let filtered = [];

        for (let i = 0; i < this.activePeers.length; i++)
        {
            let thisPeer = this.activePeers[i];

            if (thisPeer !== value)
            {
                filtered.push(thisPeer);
            }

        }

        this.queueProcessor.removeWorker(value);

        this.activePeers = JSON.parse(JSON.stringify(filtered));
    }

    private addActivePeer (value: string) { 
    
        if (!this.activePeers.includes(value))
        {
            this.activePeers.push(value);
        }

        if (!this.queueProcessor.hasWorker(value))
        {
            this.queueProcessor.addWorker(value);
        }

    }

    private async checkLocks() {

        // TODO

    }

    private async revalidateBlockchain() {

        logger.warn("Revalidating blockchain...");

        await Balance.deleteMany();

        let topBlockHeight = 0;
        const lastBlock = await Block.find().sort({height: -1}).limit(1);
        if (lastBlock.length > 0)
            topBlockHeight = lastBlock[0].height;

        let lastBlockHash = "0000000000000000000000000000000000000000000000000000000000000000";
        let lastBlockHeight = 0;
        this.difficulty = 16; // Starting diff

        for (let i = 1; i <= topBlockHeight; i++)
        {

            if (i%1000==0) logger.info("Validated up to block: " + i);

            let isValid = false;

            const block = await Block.findOne({height: i});

            let blockinfo = {
                difficulty: block.difficulty,
                hash: block.blockHash,
                id: block.height,
                lastBlockHash: block.lastBlockHash,
                merkleRoot: block.merkleRoot,
                nonce: block.nonce,
                timestamp: block.timestamp,
                transactions: []
            };

            const transactions = await Transaction.find({block: block._id}).populate("fromAddress").populate("toAddress").populate("token").sort({blockIndex: 1}); 

            for (let i = 0; i < transactions.length; i++)
            {
                let thistx = transactions[i];

                let tx = {
                    type: thistx.type,
                    amount: thistx.amount,
                    fee: thistx.fee,
                    from: thistx.fromAddress.address,
                    to: thistx.toAddress.address,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                }

                if (thistx.signature)
                {
                    tx["signature"] = thistx.signature;
                }

                if (thistx.signingKey)
                {
                    tx["signingKey"] = thistx.signingKey;
                }

                // v2 options
                if (thistx.token)
                {
                    tx["token"] = thistx.token.transaction;
                    tx["tokenAmount"] = thistx.amount;
                    tx["amount"] = 0;
                }

                blockinfo.transactions.push(tx);

                // check to make sure address record exists - if not create
                let toAddress = await Address.findOne({address: tx.to.toUpperCase()});
                let fromAddress = await Address.findOne({address: tx.from.toUpperCase()});

                if (!toAddress)
                {
                    toAddress = await Address.create({
                        address: tx.to.toUpperCase(),
                        publicKey: "",
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                }

                if (!fromAddress)
                {
                    fromAddress = await Address.create({
                        address: tx.from.toUpperCase(),
                        publicKey: thistx.signingKey?thistx.signingKey.toUpperCase():"",
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                }
                else if ((!fromAddress.publicKey || fromAddress.publicKey == "") && thistx.signingKey)
                {
                    await Address.updateOne({_id: fromAddress._id}, {$set: {publicKey: thistx.signingKey.toUpperCase()}});
                }

            }

            let medianTimestamp = 0;
            if (lastBlockHeight > 10) {
                const times: Array<number> = [];

                // get last 10 blocktimes
                const tenBlocks = await Block.find({height: {$gt: lastBlockHeight - 10}}).sort({height: -1}).limit(10);
                for (let i = 0; i < tenBlocks.length; i++) {
                  times.push(parseInt(tenBlocks[i].timestamp));
                }
                times.sort((a, b) => a - b);

                // compute median
                if (times.length % 2 === 0) {
                    medianTimestamp = (times[Math.floor(times.length / 2)] + times[Math.floor(times.length / 2) - 1]) / 2;
                } else {
                    medianTimestamp = times[Math.floor(times.length / 2)];
                }
            
            }

            let networkTimestamp = Math.round(Date.now()/1000);

            try {
                isValid = await PandaniteCore.checkBlockValid(blockinfo, lastBlockHash, lastBlockHeight, this.difficulty, networkTimestamp, medianTimestamp, block.blockReward);
            } catch (e) {
                logger.warn(e);
                isValid = false;
            }

            let expectedHeight = lastBlockHeight + 1;
            
            if (block.height != expectedHeight)
            {
                isValid = false;
            }

            if (isValid === true)
            {

                const validtrx = await Transaction.find({block: block._id}).populate("fromAddress").populate("toAddress").populate("token").sort({blockIndex: 1}); 

                for (let i = 0; i < validtrx.length; i++)
                {

                    const thisTx = validtrx[i];

                    const transactionAmount = thisTx.amount;

                    if (thisTx.fromAddress.address !== "00000000000000000000000000000000000000000000000000" && thisTx.fromAddress.address !== "")
                    {
                        const deductionAmount = Number(Big(transactionAmount).plus(thisTx.fee).times(-1).toFixed(0));
                        await Balance.updateOne({address: thisTx.fromAddress._id, token: thisTx.token}, {$inc: {balance: deductionAmount}});
                    }

                    const haveToBalance = await Balance.findOne({address: thisTx.toAddress._id, token: thisTx.token});

                    if (!haveToBalance)
                    {

                        let tokenString = null;

                        if (thisTx.token)
                        {
                            tokenString = thisTx.token.tokenId.toUpperCase()
                        }

                        await Balance.create({
                            address: thisTx.toAddress._id,
                            token: thisTx.token?._id,
                            addressString: thisTx.toAddress.address.toUpperCase(),
                            tokenString: tokenString,
                            balance: transactionAmount,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });

                    }
                    else
                    {
                        await Balance.updateOne({address: thisTx.toAddress._id, token: thisTx.token?._id}, {$inc: {balance: transactionAmount}});
                    }

                }

                this.myBlockHeight = block.height;

                const lastDiffHeight = Math.floor(this.myBlockHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

                await this.updateDifficultyForHeight(lastDiffHeight);

                lastBlockHash = block.blockHash;
                lastBlockHeight = block.height;

            }
            else
            {

                // Stop here and clear anything remaining for resume via regular sync

                const toDeleteBlocks = await Block.find({height: {$gt: lastBlockHeight}});
                for (let i = 0; i < toDeleteBlocks.length; i++)
                {
                    const blockInfo = toDeleteBlocks[i];

                    await Block.deleteOne({_id: blockInfo._id});
                    await Transaction.deleteMany({block: blockInfo._id});

                }

                break;

            }

        }

    }

    private async checkMempool() {

        // General mempool check to make sure items in the pool are still valid
        // This might be overkill since we will do the same check when adding to mempool, so this function may only need to run on first starting after sync is finished.

        const memPool = await Mempool.find();

        memPool.forEach(async (item: any) => {

            // Check if tx confirmed
            const confirmedTx = await Transaction.findOne({hash: item.hash});

            if (confirmedTx)
            {
                logger.warn("Mempool Txid " + item.hash + " is not valid.  Removing from mempool");
                await Mempool.deleteOne({_id: item._id});
                return;
            }
            else
            {
                // Make sure is valid

                if (!item.signature || !item.signingKey)
                {
                    logger.warn("Mempool Txid " + item.hash + " is not valid.  Removing from mempool");
                    await Mempool.deleteOne({_id: item._id});
                    return;
                }

                const tx = {
                    "from": item.from.toUpperCase(), 
                    "to": item.to.toUpperCase(), 
                    "fee": item.fee,
                    "amount": item.amount, 
                    "timestamp": item.timestamp,
                    "token": item.token?item.token.toUpperCase():null,
                    "signature": item.signature.toUpperCase(),
                    "signingKey": item.signingKey.toUpperCase(),
                    "type": item.type || 0
                };

                const txId = PandaniteCore.getTransactionId(tx);
                if (txId.toUpperCase() !== item.hash.toUpperCase())
                {
                    logger.warn("Mempool Txid " + item.hash + " is not valid.  Removing from mempool");
                    await Mempool.deleteOne({_id: item._id});
                    return;
                }

                const isValid = PandaniteCore.verifyTransactionSignature(txId, item.signingKey, item.signature);
                if (isValid === false)
                {
                    logger.warn("Mempool Txid " + item.hash + " is not valid.  Removing from mempool");
                    await Mempool.deleteOne({_id: item._id});
                    return;
                }

                // check account balance is sufficient
                if (item.token && tx.type === 1)
                {
                    const accountBalance = await Balance.findOne({addressString: item.from.toUpperCase(), token: null});

                    if (Big(tx.fee).gt(accountBalance.balance))
                    {
                        logger.warn("Mempool Txid " + item.hash + " not enough native balance.  Removing from mempool");
                        await Mempool.deleteOne({_id: item._id});
                        return;
                    }

                    const tokenBalance = await Balance.findOne({addressString: item.from.toUpperCase(), tokenString: item.token.toUpperCase()});

                    if (Big(tx.amount).gt(tokenBalance.balance))
                    {
                        logger.warn("Mempool Txid " + item.hash + " not enough token balance.  Removing from mempool");
                        await Mempool.deleteOne({_id: item._id});
                        return;
                    }

                }
                else if (!item.token && tx.type == 0)
                {
                    const accountBalance = await Balance.findOne({addressString: item.from.toUpperCase(), token: null});

                    const totalTxValue = Big(tx.amount).plus(tx.fee).toFixed(0);

                    if (Big(totalTxValue).gt(accountBalance.balance))
                    {
                        logger.warn("Mempool Txid " + item.hash + " not enough native balance.  Removing from mempool");
                        await Mempool.deleteOne({_id: item._id});
                        return;
                    }

                }

                // Does this from address have more than 1 mempool item?
                const addressMempool = await Mempool.countDocuments({from: item.from.toUpperCase()});
                if (addressMempool > 1)
                {
                    let memBalances = {};
                    // Additional checks to ensure address has enough balance for all mempool items
                    const accountBalances = await Balance.find({addressString: item.from.toUpperCase()});
                    for (let i = 0; i < accountBalances.length; i++)
                    {
                        const thisBal = accountBalances[i];
                        const key = thisBal.token?thisBal.tokenString:'native';
                        memBalances[key] = thisBal.balance;
                    }

                    const qmempool = await Mempool.aggregate([
                        {
                          $match: {from: item.from.toUpperCase()},
                        },{
                          $group: {
                            _id: "$token",
                            total: {
                              $sum:  "$amount"
                            },
                            totalfee: {
                              $sum:  "$fee"
                            }
                          }
                        }]
                    );

                    let memInQueue = {};
                    for (let i = 0; i < qmempool.length; i++)
                    {
                        const thisSummary = qmempool[i];
                        let key = "native";

                        if (thisSummary._id && thisSummary._id != "")
                        {
                            key = thisSummary._id;
                        }

                        if (!memInQueue[key]) memInQueue[key] = 0;
                        if (!memInQueue["native"]) memInQueue["native"] = 0;

                        memInQueue[key] = memInQueue[key] + thisSummary.total;
                        memInQueue["native"] = memInQueue["native"] + thisSummary.totalfee;

                    }

                    let haveError = false;
                    const keysInQueue = Object.keys(memInQueue);
                    for (let i = 0; i < keysInQueue.length; i++)
                    {
                        const thisKey = keysInQueue[i];
                        if (!memBalances[thisKey])
                        {
                            haveError = true;
                            break;
                        }

                        if (Big(memInQueue[thisKey]).gt(memBalances[thisKey]))
                        {
                            haveError = true;
                            break;
                        }

                    }

                    if (haveError)
                    {
                        logger.warn("Mempool From Address " + item.from.toUpperCase() + " has more items in mempool than balance.  Removing most recent from mempool");
                        const lastItem = await Mempool.find({from: item.from.toUpperCase()}).sort({createdAt: -1}).limit(1);
                        if (lastItem.length > 0)
                        {
                            await Mempool.deleteOne({_id: lastItem[0]._id});
                        }
                        return;
                    }

                }

            }

        });

    }

    private stringToHex(str: string) {
        let hexString = '';
        for (let i = 0; i < str.length; i++) {
          const hex = str.charCodeAt(i).toString(16);
          hexString += hex.padStart(2, '0');
        }
        return hexString;
    }

    private async printPeeringInfo() {

        logger.info("----===== Active Peers (" + this.activePeers.length + ") =====----");
        logger.info("NetworkName: " + globalThis.networkName);
        logger.info("BlockHeight: " + this.myBlockHeight);
        logger.info("Difficulty: " + this.difficulty);
        const currentMiningFee = PandaniteCore.getCurrentMiningFee(this.myBlockHeight + 1);
        logger.info("Current Miner Reward: " + Big(currentMiningFee).div(10**4).toFixed(4) + " PDN");

        for (let i = 0; i < this.activePeers.length; i++)
        {
            let thisPeerHeight = this.peerHeights[this.activePeers[i]] || 0;
            let thisPeerVersion = this.peerVersions[this.activePeers[i]] || 1;
            logger.info(this.activePeers[i] + " - BlockHeight: " + thisPeerHeight + " - Version: " + thisPeerVersion);
        }

        logger.info("-----------------------------------");

        return true;

    }

    private checkPeer(peer: string): Promise<boolean> {

        return new Promise<boolean>(async (resolve, reject) => {

            if (this.badPeers.includes(peer))
            {
                resolve(false);
            }

            let stripPeer = peer.replace('http://', '');
            let splitPeer = stripPeer.split(":");

            const isPortActive = await this.isPortActive(String(splitPeer[0]), Number(splitPeer[1]));

            if (isPortActive === false) {
                logger.warn("Port not active for " + peer);
                await Peer.updateMany({url: peer}, {$set: {isActive: false, updatedAt: Date.now()}});
                this.removeActivePeer(peer);
                resolve(false);
            }

            if (!["localhost", "127.0.0.1", this.myIpAddress].includes(splitPeer[0])) // don't peer with yourself.
            {  

                if (this.peerVersions[peer] === 2) // PEER VERSION 2
                {

                    // Check if already connected to v2 peer
                    if (this.websocketPeers[peer])
                    {
                        // check if websocket is still open
                        if (this.websocketPeers[peer].readyState === WebSocket.OPEN)
                        {
                            // get stats
                            const messageId = this.stringToHex(peer) + "." + uuidv4();

                            const message = {
                                method: 'getStats',
                                messageId: messageId
                            };

                            this.wsRespFunc[messageId] = async (peer: string, messageId: string, data: string) => {

                                try {

                                    const jsonparse = JSON.parse(data);
                                    const jsondata = jsonparse.data;

                                    if (!jsondata || parseInt(jsondata.current_block) === 0) throw new Error('Bad Peer');

                                    if (jsondata.network_name != globalThis.networkName) throw new Error('Bad Peer NetworkName');

                                    this.peerVersions[peer] = 2; // assumed since this is ws
            
                                    this.addActivePeer(peer);

                                    this.peerHeights[peer] = parseInt(jsondata.current_block);
            
                                    const havePeer = await Peer.countDocuments({url: peer});
            
                                    if (havePeer == 0)
                                    {
            
                                        let stripPeer = peer.replace('http://', '');
                                        let splitPeer = stripPeer.split(":");
            
                                        await Peer.create({
                                            url: peer,
                                            ipAddress: splitPeer[0],
                                            port: splitPeer[1],
                                            lastSeen: Date.now(),
                                            isActive: true,
                                            lastHeight: parseInt(jsondata.current_block),
                                            networkName: globalThis.networkName,
                                            createdAt: Date.now(),
                                            updatedAt: Date.now()
                                        });
            
                                    }
                                    else if (havePeer > 1)
                                    {
                                        await Peer.deleteMany({url: peer});

                                        let stripPeer = peer.replace('http://', '');
                                        let splitPeer = stripPeer.split(":");
            
                                        await Peer.create({
                                            url: peer,
                                            ipAddress: splitPeer[0],
                                            port: splitPeer[1],
                                            lastSeen: Date.now(),
                                            isActive: true,
                                            lastHeight: parseInt(jsondata.current_block),
                                            networkName: globalThis.networkName,
                                            createdAt: Date.now(),
                                            updatedAt: Date.now()
                                        });
                                    }
                                    else
                                    {
                                        await Peer.updateOne({url: peer}, {$set: {
                                            lastSeen: Date.now(),
                                            isActive: true,
                                            lastHeight: parseInt(jsondata.current_block),
                                            updatedAt: Date.now()
                                        }});
                                    }

                                    delete this.wsRespFunc[messageId];

                                    logger.info("Peer " + peer + ": OK");

                                } catch (e) {
    logger.warn(e);
                                    delete this.wsRespFunc[messageId];

                                    logger.warn("Peer " + peer + ": NOTOK");
                                }

                            };

                            try {
                                this.websocketPeers[peer].send(JSON.stringify(message));
                            } catch (e) {
                                // could not send message
                                logger.warn("Peer " + peer + ": NOTOK");
                                logger.warn(e);
                                delete this.wsRespFunc[messageId];
                                delete this.websocketPeers[peer]
                            }
                            
                        }
                        else
                        {

                            this.websocketPeers[peer].terminate();
                            delete this.websocketPeers[peer];

                        }

                    }
                    else
                    {

                        // Try to connect socket
                        try {

                            let that = this;

                            this.websocketPeers[peer] = new WebSocket(peer.replace("http://", "ws://"), {handshakeTimeout: 3000, timeout: 3000});

                            this.websocketPeers[peer].on('error', function err() {
                                this.removeActivePeer(peer);
                            });

                            this.websocketPeers[peer].on('open', function open() {

                                // peer notify
                                const messageId2 = that.stringToHex(peer) + "." + uuidv4();

                                const message2 = {
                                    method: 'peerNotify',
                                    hostname: that.myIpAddress,
                                    port: globalThis.appPort
                                };

                                try {
                                    that.websocketPeers[peer].send(JSON.stringify(message2));
                                } catch (e) {
                                    // could not send message
                                }

                                // get stats

                                const messageId = that.stringToHex(peer) + "." + uuidv4();

                                const message = {
                                    method: 'getStats',
                                    messageId: messageId
                                };

                                that.wsRespFunc[messageId] = async (peer: string, messageId: string, data: string) => {

                                    try {

                                        const jsonparse = JSON.parse(data);
                                        const jsondata = jsonparse.data;

                                        if (!jsondata || parseInt(jsondata.current_block) === 0) throw new Error('Bad Peer');

                                        if (jsondata.network_name != globalThis.networkName) throw new Error('Bad Peer NetworkName');

                                        that.peerVersions[peer] = 2; // assumed since this is ws
                
                                        that.addActivePeer(peer);

                                        that.peerHeights[peer] = parseInt(jsondata.current_block);
                
                                        const havePeer = await Peer.countDocuments({url: peer});
            
                                        if (havePeer == 0)
                                        {
                
                                            let stripPeer = peer.replace('http://', '');
                                            let splitPeer = stripPeer.split(":");
                
                                            await Peer.create({
                                                url: peer,
                                                ipAddress: splitPeer[0],
                                                port: splitPeer[1],
                                                lastSeen: Date.now(),
                                                isActive: true,
                                                lastHeight: parseInt(jsondata.current_block),
                                                networkName: globalThis.networkName,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            });
                
                                        }
                                        else if (havePeer > 1)
                                        {
                                            await Peer.deleteMany({url: peer});
        
                                            let stripPeer = peer.replace('http://', '');
                                            let splitPeer = stripPeer.split(":");
                
                                            await Peer.create({
                                                url: peer,
                                                ipAddress: splitPeer[0],
                                                port: splitPeer[1],
                                                lastSeen: Date.now(),
                                                isActive: true,
                                                lastHeight: parseInt(jsondata.current_block),
                                                networkName: globalThis.networkName,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            });
                                        }
                                        else
                                        {
                                            await Peer.updateOne({url: peer}, {$set: {
                                                lastSeen: Date.now(),
                                                isActive: true,
                                                lastHeight: parseInt(jsondata.current_block),
                                                updatedAt: Date.now()
                                            }});
                                        }

                                        logger.info("Peer " + peer + ": OK");

                                        that.addActivePeer(peer);

                                        delete that.wsRespFunc[messageId];

                                    } catch (e) {
    logger.warn(e);
                                        logger.warn("Peer " + peer + ": NOTOK");
                                        delete that.wsRespFunc[messageId];
                                    }

                                };

                                try {
                                    that.websocketPeers[peer].send(JSON.stringify(message));
                                } catch (e) {
                                    logger.warn("Peer " + peer + ": NOTOK");
                                    logger.warn(e);
                                    that.removeActivePeer(peer);
                                    delete that.wsRespFunc[messageId];
                                    delete that.websocketPeers[peer]
                                }

                            });
                            
                            this.websocketPeers[peer].on('message', function message(data) {

                                try {

                                    const jsondata = JSON.parse(data.toString());
                                    if (that.wsRespFunc[jsondata.messageId])
                                    {

                                        that.wsRespFunc[jsondata.messageId](peer, jsondata.messageId, data.toString());

                                    }

                                } catch (e) {

    logger.warn(e);

                                }
                            });

                            this.websocketPeers[peer].on('close', async function close() {

                                logger.warn('Websocket disconnected from peer: ' + peer);

                                delete that.websocketPeers[peer];

                                that.removeActivePeer(peer);

                                await Peer.updateOne({url: peer}, {$set: {isActive: false, updatedAt: Date.now()}});

                                // cleanup any open respfunc
                                const peerHex = that.stringToHex(peer);

                                const functionKeys = Object.keys(that.wsRespFunc);

                                for (let i = 0; i < functionKeys.length; i++)
                                {
                                    let thisKey = functionKeys[i];

                                    if (thisKey.indexOf(peerHex) === 0)
                                    {
                                        delete that.wsRespFunc[thisKey];
                                    }

                                }

                            });

                        } catch (e) {

                            logger.warn("Peer " + peer + ": NOTOK");
                            logger.warn(e);
                            this.removeActivePeer(peer);
                            delete this.websocketPeers[peer]

                        }

                    }

                }
                else // PEER VERSION 1 or Unknown version
                {

                    try {

logger.info("checking peer " + peer);
                        
                        // minimum version 0.7.13

                        const data: any = await this.getJSONFromURL(peer + "/stats");

                        if (!data || parseInt(data.current_block) === 0) {
                            throw new Error('Bad Peer');
                        }

                        if (data.network_name && data.network_name != globalThis.networkName) {
                            throw new Error('Bad Peer NetworkName');
                        }

                        if (data && data.node_version)
                        {
                            let splitVersion = data.node_version.split(".");
                            if (parseInt(splitVersion[0]) >= 2)
                            {
                                this.peerVersions[peer] = 2;
                            }
                            else
                            {

                                this.peerVersions[peer] = 1;

                                if (parseInt(splitVersion[1]) < 7) {
                                    this.badPeers.push(peer);
                                    logger.warn("Bad Peer Version " + data.node_version);
                                    throw new Error('Bad Peer Version');
                                }
    
                                if (parseInt(splitVersion[1]) == 7 && parseInt(splitVersion[2]) < 13) {
                                    this.badPeers.push(peer);
                                    logger.warn("Bad Peer Version " + data.node_version);
                                    throw new Error('Bad Peer Version');
                                }

                            }
                        }
                        else
                        {
                            this.badPeers.push(peer);
                            logger.warn("Bad Peer Version N/A");
                            throw new Error('Bad Peer Version');
                        }

                        logger.info("Peer " + peer + ": OK");

                        this.addActivePeer(peer);

                        this.peerHeights[peer] = parseInt(data.current_block);

                        const havePeer = await Peer.countDocuments({url: peer});

                        if (havePeer === 0)
                        {
                            let stripPeer = peer.replace('http://', '');
                            let splitPeer = stripPeer.split(":");

                            await Peer.create({
                                url: peer,
                                ipAddress: splitPeer[0],
                                port: splitPeer[1],
                                lastSeen: Date.now(),
                                isActive: true,
                                lastHeight: parseInt(data.current_block),
                                networkName: globalThis.networkName,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            });

                        }
                        else if (havePeer > 1)
                        {
                            // too many records for same peer.  flush all and recreate
                            await Peer.deleteMany({url: peer});

                            let stripPeer = peer.replace('http://', '');
                            let splitPeer = stripPeer.split(":");

                            await Peer.create({
                                url: peer,
                                ipAddress: splitPeer[0],
                                port: splitPeer[1],
                                lastSeen: Date.now(),
                                isActive: true,
                                lastHeight: parseInt(data.current_block),
                                networkName: globalThis.networkName,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            });
                        }
                        else
                        {
                            await Peer.updateOne({url: peer}, {$set: {
                                lastSeen: Date.now(),
                                isActive: true,
                                lastHeight: parseInt(data.current_block),
                                updatedAt: Date.now()
                            }});
                        }                        

                    } catch (e) {

                        //console.log(e);

                        logger.warn("Peer " + peer + ": NOTOK");

                        await Peer.updateMany({url: peer}, {$set: {isActive: false, updatedAt: Date.now()}});

                        // peer timeout or some other issue - remove until somebody tells us its active again

                        this.removeActivePeer(peer);
                        
                    }

                }

            }

            resolve(true);

        });

    }

    private checkPeers(): Promise<boolean>   {

        return new Promise<boolean>(async (resolve, reject) => {

            if (globalThis.shuttingDown === true) resolve(false);

            this.checkingPeers = true;
            this.checkPeerLock = Date.now();
            
            // Check oldest 5 peers
            const peerList = await Peer.find({isActive: true}).sort({lastSeen: 1}).limit(5);

            let pendingPeers = [];

            for (let i = 0; i < peerList.length; i++)
            {
                let thisPeer = peerList[i];
                if (thisPeer.url)
                    pendingPeers.push(thisPeer.url);
            }

            if (pendingPeers.length === 0)
            {
                logger.warn("No active peers.  Using default peers")
                pendingPeers = globalThis.defaultPeers;
            }

            let allPromises = [];

            logger.info("checking " + pendingPeers.length + " peers");

            for (let i = 0; i < pendingPeers.length; i++)
            {
                allPromises[i] = this.checkPeer(pendingPeers[i]);
            }

            if (allPromises.length > 0)
            {
                await Promise.all(allPromises);
            }

            this.checkingPeers = false;
            this.checkPeerLock = 0;

            resolve(true);

        });

    }

    private findPeers(): Promise<boolean>  {

        return new Promise<boolean>(async (resolve, reject) => {

            if (globalThis.shuttingDown === true) resolve(false);

            this.findingPeers = true;
            this.findPeerLock = Date.now();

            let allPromises = [];

            try {

                // make copy
                const localActive: string[] = JSON.parse(JSON.stringify(this.activePeers));

                if (localActive.length == 0) resolve(true);

                // just select one peer to find new peers from each run
                const randomIndex = Math.floor(Math.random() * localActive.length);

                const peer = localActive[randomIndex] // Select a random peer to get peer info from

                logger.info("random peer test: " + peer)

                const data: any = await this.getJSONFromURL(peer + "/peers");

                if (!data || data.length === 0) resolve(false);

                for (let i = 0; i < data.length; i++)
                {

                    let thisPeer = String(data[i]);

                    let stripPeer = thisPeer.replace('http://', '');
                    let splitPeer = stripPeer.split(":");

                    if (splitPeer.length !== 2) continue;

                    if (["localhost", "127.0.0.1", this.myIpAddress].includes(splitPeer[0]) && splitPeer[1] === globalThis.appPort)
                    {
                        // apparent self reference, skip
                        continue;
                    }
                    else
                    {

                        if (this.badPeers.includes(thisPeer)) {
                            continue;
                        }

                        let peerCheck = this.doPeerCheck(thisPeer, String(splitPeer[0]), Number(splitPeer[1]));

                        allPromises.push(peerCheck);

                    }

                }

            } catch (e) {

                // peer timeout
                
            }

            if (allPromises.length > 0) {
                await Promise.all(allPromises);
            }

            this.findingPeers = false;
            this.findPeerLock = 0;

            resolve(true);

        });

    }

    private doPeerCheck(url: string, ip: string, port: number): Promise<boolean> {

        return new Promise<boolean>(async (resolve, reject) => {

            const isPortActive = await this.isPortActive(ip, port);

            if (isPortActive === true)
            {

                await Peer.updateOne(
                    { url: url },
                    { $set: {
                        isActive: true,
                        networkName: globalThis.networkName,
                        updatedAt: Date.now()
                    },
                    $setOnInsert: {
                        ipAddress: ip,
                        port: port,
                        lastSeen: 0,
                        lastHeight: 0,
                        createdAt: Date.now()
                    }
                    },
                    { upsert: true } // Make this update into an upsert
                );

                logger.info("Found new peer " + url);

            }

        });

    }

    private downloadBlocks(): Promise<boolean>   {

        return new Promise<boolean>(async (resolve, reject) => {

            if (globalThis.shuttingDown === true) resolve(false);

            this.downloadingBlocks = true;

            let start = this.myBlockHeight + 1;
            let end = start + 500;

            let maxHeight = 0;
            let allHeights = Object.keys(this.peerHeights);
            for (let i = 0; i < allHeights.length; i++)
            {
                if (this.peerHeights[allHeights[i]] > maxHeight)
                {
                    maxHeight = this.peerHeights[allHeights[i]];
                }
            }

            if (maxHeight === 0) resolve(false);

            if (maxHeight < end) end = maxHeight;

            for (let i = start; i <= end; i++)
            {

                if (!this.downloadedBlocks[i] && !this.queueProcessor.hasqueue(i))
                {
                    this.downloadedBlocks[i] = 'pending';
                    this.queueProcessor.enqueue(i);
                }
                
            }

            this.downloadingBlocks = false;

            resolve(true);

        });

    }

    private syncBlocks(): Promise<boolean>   {

        return new Promise<boolean>(async (resolve, reject) => {

            if (globalThis.shuttingDown === true) resolve(false);

            globalThis.safeToShutDown = false;
            this.syncingBlocks = true;
            this.syncBlocksLock = Date.now();

            const downloadedBlockKeys = Object.keys(this.downloadedBlocks);

            // cleanup
            for (let i = 0; i < downloadedBlockKeys.length; i++)
            {
                let thisKey = parseInt(downloadedBlockKeys[i]);
                if (thisKey < this.myBlockHeight)
                {
                    delete this.downloadedBlocks[thisKey];
                }
            }

            if (Object.keys(this.downloadedBlocks).length > 0)
            {

                let nextHeight = this.myBlockHeight + 1;
                let maxRunHeight = nextHeight + 500;

                importer:
                for (let i = nextHeight; i < maxRunHeight; i++)
                {

                    if (this.downloadedBlocks[i] && this.downloadedBlocks[i] !== 'pending')
                    {

                        const data = this.downloadedBlocks[i];

                        try {
                            await this.importBlock(data);
                            delete this.downloadedBlocks[i];
                        } catch (e) {
    logger.warn(e);
                            delete this.downloadedBlocks[i];
                            this.queueProcessor.requeue(i);
                            const previousHeight = i - 1;
                            await this.doBlockRollback(previousHeight);
                            break importer;
                        }

                    }
                    else
                    {
                        break importer;
                    }
                    
                }

            }

            globalThis.safeToShutDown = true;
            this.syncingBlocks = false;
            this.syncBlocksLock = 0;

            resolve(true);

        });

    }

    private doBlockRollback(height: number): Promise<boolean> {

        return new Promise<boolean>(async (resolve, reject) => {

            logger.warn("Rolling back block #" + height);

            const blockInfo = await Block.findOne({height: height}).populate("transactions");

            if (blockInfo)
            {

                try {

                    for (let i = 0; i < blockInfo.transactions.length; i++)
                    {

                        const thisTx = blockInfo.transactions[i];

                        let fromAddress = await Address.findOne({_id: thisTx.fromAddress});

                        if (fromAddress.address !== "00000000000000000000000000000000000000000000000000" && fromAddress.address !== "")
                        {
                            const increaseAmount = Number(Big(thisTx.amount).plus(thisTx.fee).toFixed(0));
                            await Balance.updateOne({address: thisTx.fromAddress, token: thisTx.token}, {$inc: {balance: increaseAmount}});
                        }

                        const deductionAmount = Number(Big(thisTx.amount).times(-1).toFixed(0));

                        await Balance.updateOne({address: thisTx.toAddress, token: thisTx.token}, {$inc: {balance: deductionAmount}});

                        await Transaction.deleteOne({_id: thisTx._id});

                    }

                    await Block.deleteOne({_id: blockInfo._id});

                    this.myBlockHeight = height - 1;

                    const lastDiffHeight = Math.floor(this.myBlockHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

                    await this.updateDifficultyForHeight(lastDiffHeight);
        
                    resolve(true);

                } catch (e) {

                    // in case of fail above, then we should start over or at least run a recompute on the chain...

                    logger.warn(blockInfo);

                    logger.warn(e);

                    logger.warn("Caught error on rollback.  EXIT")

                    process.exit(-1);

                    //await Block.deleteMany();
                    //await Transaction.deleteMany();
                    //await Balance.deleteMany();
                    //await Token.deleteMany();

                }

            }
            else
            {

                const txList = Transaction.find({blockHeight: height});

                for (let i = 0; i < txList.length; i++)
                {

                    const thisTx = txList[i];

                    let fromAddress = await Address.findOne({_id: thisTx.fromAddress});

                    if (fromAddress.address !== "00000000000000000000000000000000000000000000000000" && fromAddress.address !== "")
                    {
                        const increaseAmount = Number(Big(thisTx.amount).plus(thisTx.fee).toFixed(0));
                        await Balance.updateOne({address: thisTx.fromAddress, token: thisTx.token}, {$inc: {balance: increaseAmount}});
                    }

                    const deductionAmount = Number(Big(thisTx.amount).times(-1).toFixed(0));

                    await Balance.updateOne({address: thisTx.toAddress, token: thisTx.token}, {$inc: {balance: deductionAmount}});

                    await Transaction.deleteOne({_id: thisTx._id});

                }

                this.myBlockHeight = height - 1;

                const lastDiffHeight = Math.floor(this.myBlockHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

                await this.updateDifficultyForHeight(lastDiffHeight);
    
                resolve(true);

            }

        });

    }

    private importBlock(block: any): Promise<any> {

        return new Promise<any>(async (resolve, reject) => {

            try {

                const lastBlock = await Block.findOne({height: this.myBlockHeight});

                let lastHeight = 0;
                let isValid = false;
                let blockReward = 0;

                if (lastBlock)
                {
                    lastHeight = lastBlock.height;
                    let expectedHeight = lastHeight + 1;

                    if (block.id != expectedHeight)
                    {
                        reject('Invalid Block. Unexpected Height');
                    }

                    let medianTimestamp = 0;
                    if (this.myBlockHeight > 10) {
                        const times: Array<number> = [];

                        // get last 10 blocktimes
                        const tenBlocks = await Block.find({height: {$gt: this.myBlockHeight - 10}}).sort({height: -1});
                        for (let i = 0; i < tenBlocks.length; i++) {
                            times.push(parseInt(tenBlocks[i].timestamp));
                        }
                        times.sort((a, b) => a - b);

                        // compute median
                        if (times.length % 2 === 0) {
                            medianTimestamp = (times[Math.floor(times.length / 2)] + times[Math.floor(times.length / 2) - 1]) / 2;
                        } else {
                            medianTimestamp = times[Math.floor(times.length / 2)];
                        }
                    
                    }

                    let networkTimestamp = Math.round(Date.now()/1000);

                    // fix for transactions ordering, as generate transaction should always be first when doing the balance checks
                    block.transactions.sort((a, b) => {
                        return a.from < b.from ? -1 : 1;
                    });

                    blockReward = block.transactions[0].amount;

                    try {
                        isValid = await PandaniteCore.checkBlockValid(block, lastBlock.blockHash, lastBlock.height, this.difficulty, networkTimestamp, medianTimestamp, blockReward);
                    } catch (e) {
                        logger.warn(e);
                        reject(e);
                    }

                    // Poor previous design requires this in order to sync :(
                    const excludedTransactions = [

                    ];

                    let pendingAmounts = {};

                    // Check Balances - excluded for block height < V2 starting height as there are a few transactions that do not pass this test
                    if (block.id > 600000)
                    for (let i = 0; i < block.transactions.length; i++)
                    {
                        const thisTrx = block.transactions[i];

                        let tokenKey = thisTrx.token?thisTrx.token.toUpperCase():'native';

                        let pendingKey = `${thisTrx.to.toUpperCase()}:${tokenKey}`;

                        pendingAmounts[pendingKey] = thisTrx.amount;

                        if (!excludedTransactions.includes(thisTrx.txid.toUpperCase()) && thisTrx.from && thisTrx.from != "00000000000000000000000000000000000000000000000000")
                        {
                            if (!thisTrx.type || thisTrx.type === 0)
                            {
                                // standard transfer

                                // get address balance
                                const balanceInfo = await Balance.findOne({addressString: thisTrx.from.toUpperCase(), token: null});

                                let nativependingKey = `${thisTrx.from.toUpperCase()}:native`;

                                if (!balanceInfo && !pendingAmounts[nativependingKey])
                                {
                                    logger.warn("Transaction Missing Account Balance " + thisTrx.txid + " Address: " +  thisTrx.from.toUpperCase());
                                    isValid = false;
                                    break;
                                }
                                else if (!balanceInfo)
                                {
                                    const pendingAmount = pendingAmounts[nativependingKey] || 0;

                                    const totalTxAmount = Big(thisTrx.amount).plus(thisTrx.fee).toFixed();

                                    if (Big(totalTxAmount).gt(pendingAmount))
                                    {
                                        logger.warn("Transaction Amount Exceeds Account Balance " + thisTrx.txid + " Value: " + totalTxAmount + " >  Balance: " + pendingAmount);
                                        isValid = false;
                                        break;
                                    }
                                }
                                else
                                {

                                    const pendingAmount = pendingAmounts[nativependingKey] || 0;

                                    const totalTxAmount = Big(thisTrx.amount).plus(thisTrx.fee).toFixed();

                                    const totalAvailable = Big(balanceInfo.balance).plus(pendingAmount);

                                    if (Big(totalTxAmount).gt(totalAvailable))
                                    {
                                        logger.warn("Transaction Amount Exceeds Account Balance " + thisTrx.txid + " Value: " + totalTxAmount + " >  Balance: " + balanceInfo.balance + " + Pending Balance: " + pendingAmount);
                                        isValid = false;
                                        break;
                                    }
                                }
                            }
                            else if (thisTrx.type === 1)
                            {
                                // token transfer

                                if (!thisTrx.token) {
                                    isValid = false;
                                    break;
                                }

                                const tokenInfo = await Token.findOne({tokenId: thisTrx.token.toUpperCase()});

                                if (!tokenInfo) {
                                    isValid = false;
                                    break;
                                }

                                let nativependingKey = `${thisTrx.from.toUpperCase()}:native`;
                                let tokenKey = thisTrx.token.toUpperCase();
                                let tokenpendingKey = `${thisTrx.from.toUpperCase()}:${tokenKey}`;

                                // get address native balance
                                let balanceInfo = await Balance.findOne({addressString: thisTrx.from.toUpperCase(), token: null});

                                if (!balanceInfo && !pendingAmounts[nativependingKey])
                                {
                                    logger.warn("Transaction Missing Account Balance " + thisTrx.txid + " Address: " +  thisTrx.from.toUpperCase());
                                    isValid = false;
                                    break;
                                }
                                else if (!balanceInfo)
                                {
                                    balanceInfo = {balance: pendingAmounts[nativependingKey]};
                                }
                                else if (pendingAmounts[nativependingKey])
                                {
                                    balanceInfo.balance = balanceInfo.balance + pendingAmounts[nativependingKey];
                                }
                                
                                // get address token balance
                                let tokenBalanceInfo = await Balance.findOne({addressString: thisTrx.from.toUpperCase(), token: tokenInfo._id});


                                if (!tokenBalanceInfo && !pendingAmounts[tokenpendingKey])
                                {
                                    logger.warn("Transaction Missing Token Account Balance " + thisTrx.txid + " Address: " +  thisTrx.from.toUpperCase());
                                    isValid = false;
                                    break;
                                }
                                else if (!tokenBalanceInfo)
                                {
                                    tokenBalanceInfo = {balance: pendingAmounts[tokenpendingKey]};
                                }
                                else if (pendingAmounts[tokenpendingKey])
                                {
                                    balanceInfo.balance = balanceInfo.balance + pendingAmounts[tokenpendingKey];
                                }

                                if (!balanceInfo || !tokenBalanceInfo) 
                                {
                                    isValid = false;
                                    break;
                                }
                                else
                                {
                                    const txFeeAmount = Big(thisTrx.fee).toFixed();

                                    if (Big(txFeeAmount).gt(balanceInfo.balance))
                                    {
                                        logger.warn("Transaction Amount Exceeds Account Native Balance " + thisTrx.txid + " FeeValue: " + txFeeAmount + " >  Balance: " + balanceInfo.balance);
                                        isValid = false;
                                        break;
                                    }

                                    const tokenAmount = Big(thisTrx.tokenAmount).toFixed();

                                    if (Big(tokenAmount).gt(tokenBalanceInfo.balance))
                                    {
                                        logger.warn("Transaction Amount Exceeds Account Token Balance " + thisTrx.txid + " Value: " + tokenAmount + " >  Balance: " + tokenBalanceInfo.balance);
                                        isValid = false;
                                        break;
                                    }

                                }
                            }
                        }
                    }

                }
                else if (block.id === 1)
                {

                    let medianTimestamp = 0;
                    let networkTimestamp = Math.round(Date.now()/1000);

                    try {
                        isValid = await PandaniteCore.checkBlockValid(block, "0000000000000000000000000000000000000000000000000000000000000000", 0, this.difficulty, networkTimestamp, medianTimestamp, 0);
                    } catch (e) {
                        logger.warn(e);
                        reject(e);
                    }

                }

                if (isValid === true)
                {

                    let previousTotalWork = Big(0).toFixed();

                    if (lastBlock)
                    {
                        previousTotalWork= lastBlock.totalWork
                    }

                    const totalWork = Big(previousTotalWork).plus(block.difficulty).toFixed(0);

                    // add block to db

                    const newBlock = {
                        nonce: block.nonce.toUpperCase(),
                        height: block.id,
                        totalWork: totalWork,
                        difficulty: block.difficulty,
                        timestamp: block.timestamp,
                        merkleRoot: block.merkleRoot.toUpperCase(),
                        blockHash: block.hash.toUpperCase(),
                        lastBlockHash: block.lastBlockHash.toUpperCase(),
                        transactions: [],
                        blockReward: blockReward,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };

                    const blockInfo = await Block.create(newBlock);

                    let blockTx = [];

                    for (let i = 0; i < block.transactions.length; i++)
                    {

                        try {

                            const thisTx = block.transactions[i];

                            let tokenInfo = null;
                            if (thisTx.token)
                            {
                                tokenInfo = await Token.findOne({transaction: thisTx.token.toUpperCase()});
                            }

                            let tokenId = null;
                            if (tokenInfo)
                            {
                                tokenId = tokenInfo._id;
                            }

                            let toAddress = await Address.findOne({address: thisTx.to.toUpperCase()});
                            let fromAddress = await Address.findOne({address: thisTx.from.toUpperCase()});

                            if (!toAddress)
                            {
                                toAddress = await Address.create({
                                    address: thisTx.to.toUpperCase(),
                                    publicKey: "",
                                    createdAt: Date.now(),
                                    updatedAt: Date.now()
                                });
                            }

                            if (!fromAddress)
                            {
                                fromAddress = await Address.create({
                                    address: thisTx.from.toUpperCase(),
                                    publicKey: thisTx.signingKey?thisTx.signingKey.toUpperCase():"",
                                    createdAt: Date.now(),
                                    updatedAt: Date.now()
                                });
                            }
                            else if ((!fromAddress.publicKey || fromAddress.publicKey == "") && thisTx.signingKey)
                            {
                                await Address.updateOne({_id: fromAddress._id}, {$set: {publicKey: thisTx.signingKey.toUpperCase()}});
                            }

                            const transactionAmount: number = thisTx.token?thisTx.tokenAmount:thisTx.amount;

                            const newTransaction = {
                                type: thisTx.type || 0,
                                toAddress: toAddress._id,
                                fromAddress: fromAddress._id,
                                signature: thisTx.signature?thisTx.signature.toUpperCase():null,
                                hash: thisTx.txid.toUpperCase(),
                                amount: transactionAmount,
                                token: tokenId,
                                fee: thisTx.fee,
                                isGenerate: thisTx.from===""?true:false,
                                nonce: thisTx.timestamp,
                                signingKey: thisTx.signingKey?thisTx.signingKey.toUpperCase():null,
                                block: blockInfo._id,
                                blockHeight: block.id,
                                blockIndex: i,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            }

                            const newTx = await Transaction.create(newTransaction);

                            await Mempool.deleteMany({hash: thisTx.txid});

                            blockTx.push(newTx._id);

                            if (thisTx.from !== "00000000000000000000000000000000000000000000000000" && thisTx.from !== "")
                            {
                                const deductionAmount = Number(Big(transactionAmount).plus(thisTx.fee).times(-1).toFixed(0));
                                await Balance.updateOne({address: fromAddress._id, token: tokenId}, {$inc: {balance: deductionAmount}});
                            }

                            const haveToBalance = await Balance.findOne({address: toAddress._id, token: tokenId});

                            if (!haveToBalance)
                            {
                                await Balance.create({
                                    address: toAddress._id,
                                    token: tokenId,
                                    addressString: thisTx.to.toUpperCase(),
                                    tokenString: thisTx.token?.toUpperCase(),
                                    balance: thisTx.amount,
                                    createdAt: Date.now(),
                                    updatedAt: Date.now()
                                });

                            }
                            else
                            {
                                await Balance.updateOne({address: toAddress._id, token: tokenId}, {$inc: {balance: transactionAmount}});
                            }

                        } catch (e) {

                            logger.warn(e);
                            reject(e);

                        }

                    }

                    await Block.updateOne({_id: blockInfo._id}, {$set: {transactions: blockTx}});

                    this.myBlockHeight = block.id;

                    const lastDiffHeight = Math.floor(block.id/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;
            
                    await this.updateDifficultyForHeight(lastDiffHeight);

                    logger.info("Imported Block #" + block.id);

                    resolve(true);

                }
                else
                {
                    // deactivate peer which gave us this block

                    logger.warn("Peer " + block.receivedFromPeer + ": BADBLOCK");

                    await Peer.updateMany({url: block.receivedFromPeer}, {$set: {isActive: false, updatedAt: Date.now()}});

                    this.removeActivePeer(block.receivedFromPeer);

                    reject('Invalid Block.');
                }

            } catch (e) {

                reject(e);

            }

        });

    }

    private updateDifficulty(): Promise<any> {

        return new Promise<any>(async (resolve, reject) => {

            const lastDiffHeight = Math.floor(this.myBlockHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

            await this.updateDifficultyForHeight(lastDiffHeight);

            resolve(true);

        });

    }

    private updateDifficultyForHeight(height: number): Promise<any> {

        return new Promise<any>(async (resolve, reject) => {

            try {

                if (height <= Constants.DIFFICULTY_LOOKBACK * 2) resolve(false);
                if (height % Constants.DIFFICULTY_LOOKBACK !== 0) resolve(false);

                const firstID: number = height - Constants.DIFFICULTY_LOOKBACK;
                const lastID: number = height;
                const first = await Block.findOne({height: firstID});
                const last = await Block.findOne({height: lastID});

                if (!first)
                {
                    logger.info("Could not find first block: " + firstID);
                    resolve(false);
                }

                if (!last)
                {
                    logger.info("Could not find last block: " + lastID);
                    resolve(false);
                }

                const elapsed: number = last.timestamp - first.timestamp;
                const numBlocksElapsed: number = lastID - firstID;
                const target: number = numBlocksElapsed * Constants.DESIRED_BLOCK_TIME_SEC;
                const difficulty: number = last.difficulty;
                this.difficulty = PandaniteCore.computeDifficulty(difficulty, elapsed, target);
            
                if (
                    height >= Constants.PUFFERFISH_START_BLOCK &&
                    height < Constants.PUFFERFISH_START_BLOCK + Constants.DIFFICULTY_LOOKBACK * 2
                ) {
                    this.difficulty = Constants.MIN_DIFFICULTY;
                }

                logger.info("New Difficulty: " + this.difficulty);

                resolve(true);

            } catch (e) {

                resolve(false);
                
            }

        });

    }

    private isPortActive(ip: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
          const socket = new net.Socket();

          const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
          }, 2000);

          socket.on('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
          });
      
          socket.on('error', () => {
            clearTimeout(timer);
            resolve(false);
          });
      
          socket.connect(port, ip);
        });
    }

    private getJSONFromURL(url: string): Promise<any> {
      return new Promise((resolve, reject) => {

        const options = {
            headers: {
                'Connection': 'keep-alive'
            }
        };

        const request = http.get(url, options, (res) => {
          let data = '';

          if (res.statusCode != 200) {
            request.destroy();
            console.log(url + " returned " + res.statusCode);
            reject("Error Code " + res.statusCode);
          }

          res.on('data', (chunk) => {
            data += chunk;
          });
    
          res.on('end', () => {
            try {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } catch (error) {
              reject(error);
            }
          });
        });
    
        request.on('error', (error) => {
          reject(error);
        });

        setTimeout(() => {
            request.destroy();
            reject(new Error('Request timed out'));
        }, 3000);

      });
    }
    
    private getStringFromURL(url: string): Promise<string> {
        return new Promise((resolve, reject) => {

          const options = {
            headers: {
                'Connection': 'keep-alive'
            }
          };

          const request = http.get(url, options, (res) => {
            let data = '';

            if (res.statusCode != 200) {
                request.destroy();
                console.log(url + " returned " + res.statusCode);
                reject("Error Code " + res.statusCode);
            }

            res.on('data', (chunk) => {
              data += chunk;
            });
      
            res.on('end', () => {
              try {
                const stringData = data;
                resolve(stringData);
              } catch (error) {
                reject(error);
              }
            });
          });
      
          request.on('error', (error) => {
            reject(error);
          });

          setTimeout(() => {
            request.destroy();
            reject(new Error('Request timed out'));
          }, 3000);

        });
      }

}