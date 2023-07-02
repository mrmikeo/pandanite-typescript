import { PandaniteCore } from './Core'
import axios from 'axios';
import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema, mempoolSchema } from '../models/Model';
import Big from 'big.js';
import { Constants } from "./Constants"
import * as minimist from 'minimist';
import * as WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

import { createLogger, format, transports } from 'winston';
import { keys } from 'underscore';
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

axios.defaults.timeout === 3000;

/***
 * This queue is for downloading the blockchain, but can be used for any purpose that requires a queue with one or more workers
 */
class AsyncQueue<T> {
    private queue: T[];
    private enqueuePromise: Promise<void> | null;
    private enqueueResolve: (() => void) | null;
  
    constructor() {
      this.queue = [];
      this.enqueuePromise = null;
      this.enqueueResolve = null;
    }
  
    enqueue(item: T): Promise<void> {
      return new Promise<void>((resolve) => {
        this.queue.push(item);
        if (this.enqueueResolve) {
          this.enqueueResolve();
        }
        this.enqueueResolve = resolve;
      });
    }

    requeue(item: T): Promise<void> {
        return new Promise<void>((resolve) => {
          this.queue.unshift(item);
          if (this.enqueueResolve) {
            this.enqueueResolve();
          }
          this.enqueueResolve = resolve;
        });
      }

    async dequeue(): Promise<T> {
      while (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.enqueueResolve = resolve;
        });
      }
  
      return this.queue.shift()!;
    }

    hasqueue(item: T): boolean {
        if (this.queue.indexOf(item) > -1) return true;
        return false;
    }
    
    isEmpty(): boolean {
      return this.queue.length === 0;
    }
}
  
type Worker<T> = (hostname: string, item: T) => Promise<void>;

class QueueProcessor<T> {
    private queue: AsyncQueue<T>;
    private workers: Map<string, boolean>;
    private workerFunction: Worker<T>;
  
    constructor() {
      this.queue = new AsyncQueue<T>();
      this.workers = new Map<string, boolean>();
      this.workerFunction = this.defaultWorkerFunction;
      this.processQueue();
    }
  
    addWorker(hostname: string): void {
      this.workers.set(hostname, false);
    }
  
    addFunction(workerFunction: Worker<T>): void {
      this.workerFunction = workerFunction;
    }
  
    removeWorker(hostname: string): void {
      this.workers.delete(hostname);
    }

    hasWorker(hostname: string): boolean {
        return this.workers.has(hostname);
    }

    async processQueue(): Promise<void> {
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
    
          this.workerFunction(hostname, item).then(() => {
            this.workers.set(hostname, false); // Mark the worker as available again
          });
        }
    }
  
    enqueue(item: T): void {
      if (!this.queue.hasqueue(item))
        this.queue.enqueue(item);
    }

    requeue(item: T): void {
        if (!this.queue.hasqueue(item))
          this.queue.requeue(item);
    }

    hasqueue(item: T): boolean {
        return this.queue.hasqueue(item);
    }

    private defaultWorkerFunction: Worker<T> = async (hostname, item) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    pendingPeers: Array<string>;
    currentPeer: string;
    downloadedBlocks: Object;
    peerHeights: Object;
    peerVersions: Object;
    queueProcessor: QueueProcessor<number>;
    myBlockHeight: number;
    difficulty: number;
    websocketPeers: Object;
    wsRespFunc: Object;
    myIpAddress: string;

    constructor() {
        this.activePeers = [];
        this.pendingPeers = [];
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
        this.queueProcessor = new QueueProcessor<number>();
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
            const response = await axios.get('http://api.ipify.org/')
            logger.info("My public IP address is: " + response.data);
            this.myIpAddress = response.data;
        } catch (e) {}

        // start jobs for syncing peers list & blocks

        const that = this;

        const workerFunction: Worker<number> = async (thisPeer, height) => {

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

                                    that.downloadedBlocks[height] = jsondata;
                                    delete that.wsRespFunc[messageId];

                                }
                                else
                                {
                                    //const index = this.activePeers.indexOf(thisPeer);
                                    //if (index > -1) {
                                    //    this.activePeers.splice(index, 1);
                                    //}
                                    delete that.downloadedBlocks[height];
                                    //this.queueProcessor.removeWorker(thisPeer);
                                    that.queueProcessor.requeue(height);
                                    delete that.wsRespFunc[messageId];
                                }

                            } catch (e) {


                            }

                        };

                        try {
                            that.websocketPeers[thisPeer].send(JSON.stringify(message));
                        } catch (e) {
                            delete that.wsRespFunc[messageId];
                            delete that.websocketPeers[thisPeer];
                        }
                    }
                    else
                    {
                    
                        const response = await axios({
                            url: thisPeer + "/block?blockId=" + height,
                            method: 'get',
                            responseType: 'json'
                        });
            
                        const data = response.data;
            
                        if (data && data.hash)
                        {
                            this.downloadedBlocks[height] = response.data;
                        }
                        else
                        {
                            const index = this.activePeers.indexOf(thisPeer);
                            if (index > -1) {
                                this.activePeers.splice(index, 1);
                            }
                            delete this.downloadedBlocks[height];
                            this.queueProcessor.removeWorker(thisPeer);
                            this.queueProcessor.requeue(height);
                        }

                    }

                }
                else
                {

                    delete this.downloadedBlocks[height];
                    this.queueProcessor.requeue(height);

                }

            } catch (e) {
    
                const index = this.activePeers.indexOf(thisPeer);
                if (index > -1) {
                    this.activePeers.splice(index, 1);
                }
    
                delete this.downloadedBlocks[height];
                this.queueProcessor.removeWorker(thisPeer);
                this.queueProcessor.requeue(height);
    
            }

        };

        // Add worker function to the processing queue
        this.queueProcessor.addFunction(workerFunction);

        const lastDiffHeight = Math.floor(height/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

        logger.info("My block height is " + height);
        logger.info("Last diff height is " + lastDiffHeight);

        await this.updateDifficultyForHeight(lastDiffHeight);

        this.checkPeers();

        // Interval jobs
        setInterval(function() {
            if (!that.checkingPeers && globalThis.shuttingDown == false)
            {
                that.checkPeers();
            }
            if (!that.findingPeers && globalThis.shuttingDown == false)
            {
                that.findPeers();
            }
            that.checkLocks();
            that.printPeeringInfo();
        }, 20000);

        setInterval(function() {
            if (!that.downloadingBlocks)
            {
                that.downloadBlocks();
            }
            if (!that.syncingBlocks && globalThis.shuttingDown == false)
            {
                that.syncBlocks();
            }
        }, 1000);

    }

    public async checkLocks() {

        // TODO

    }

    public async revalidateBlockchain() {

        await Balance.deleteMany();

        const allBlocks = await Block.find().sort({height: 1});

        let lastBlockHash = "0000000000000000000000000000000000000000000000000000000000000000";
        let lastBlockHeight = 0;
        this.difficulty = 16; // Starting diff

        for (let i = 0; i < allBlocks.length; i++)
        {

            let isValid = false;

            const block = allBlocks[i];

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
                const tenBlocks = await Block.find({height: {$gt: lastBlockHeight - 10}}).sort({height: -1});
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
                isValid = await PandaniteCore.checkBlockValid(block, lastBlockHash, lastBlockHeight, this.difficulty, networkTimestamp, medianTimestamp, block.blockReward);
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
                        await Balance.updateOne({address: thisTx.fromAddress._id, token: thisTx.token}, {$inc: {balance: -transactionAmount}});
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

                await this.updateDifficulty();

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

    public async checkMempool() {

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

    public stringToHex(str: string) {
        let hexString = '';
        for (let i = 0; i < str.length; i++) {
          const hex = str.charCodeAt(i).toString(16);
          hexString += hex.padStart(2, '0');
        }
        return hexString;
    }

    public async printPeeringInfo() {

        logger.info("----===== Active Peers (" + this.activePeers.length + ") =====----");
        logger.info("NetworkName: " + globalThis.networkName);
        logger.info("BlockHeight: " + this.myBlockHeight);
        logger.info("Difficulty: " + this.difficulty);

        for (let i = 0; i < this.activePeers.length; i++)
        {
            let thisPeerHeight = this.peerHeights[this.activePeers[i]] || 0;
            let thisPeerVersion = this.peerVersions[this.activePeers[i]] || 1;
            logger.info(this.activePeers[i] + " - BlockHeight: " + thisPeerHeight + " - Version: " + thisPeerVersion);
        }

        logger.info("-----------------------------------");

        return true;

    }

    public async checkPeers()  {

        this.checkingPeers = true;
        this.checkPeerLock = Date.now();
        const that = this;

        const peerList = await Peer.find({isActive: true});

        for (let i = 0; i < peerList.length; i++)
        {
            let thisPeer = peerList[i];
            if (!this.pendingPeers.includes("http://" + thisPeer.ipAddress + ":" + thisPeer.port))
                this.pendingPeers.push("http://" + thisPeer.ipAddress + ":" + thisPeer.port);
        }

        if (this.pendingPeers.length === 0)
        {
            this.pendingPeers = globalThis.defaultPeers;
        }

        this.pendingPeers.forEach(async (peer) => {

            let stripPeer = peer.replace('http://', '');
            let splitPeer = stripPeer.split(":");
            if (splitPeer[0] != this.myIpAddress)
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

                                    that.peerVersions[peer] = 2; // assumed since this is ws
            
                                    if (!that.activePeers.includes(peer))
                                        that.activePeers.push(peer);
            
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

                                    delete that.wsRespFunc[messageId];

                                } catch (e) {
logger.warn(e);
                                    delete that.wsRespFunc[messageId];
                                }

                            };

                            try {
                                this.websocketPeers[peer].send(JSON.stringify(message));
                            } catch (e) {
                                // could not send message
                                delete that.wsRespFunc[messageId];
                                delete this.websocketPeers[peer]
                            }
                            
                        }

                    }
                    else
                    {
                        // Try to connect socket
                        try {

                            const client = new WebSocket(peer.replace("http://", "ws://"));
                            client.onopen = function() {

                                that.websocketPeers[peer] = this;

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
                
                                        if (!that.activePeers.includes(peer))
                                            that.activePeers.push(peer);
                
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

                                        delete that.wsRespFunc[messageId];

                                    } catch (e) {
logger.warn(e);
                                        delete that.wsRespFunc[messageId];
                                    }

                                };

                                try {
                                    this.send(JSON.stringify(message));
                                } catch (e) {
                                    delete that.wsRespFunc[messageId];
                                    delete that.websocketPeers[peer]
                                }

                            }
                            
                            client.on('message', function message(data) {

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

                            client.on('close', function close() {

                                logger.warn('Websocket disconnected from peer: ' + peer);

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

                                delete that.websocketPeers[peer];

                            });

                        } catch (e) {

logger.warn(e);

                        }

                    }

                }
                else // PEER VERSION 1 or Unknown version
                {

                    try {

                        const response = await axios.get(peer + "/stats");
                        const data = response.data;

                        if (!data || parseInt(data.current_block) === 0) throw new Error('Bad Peer');

                        if (data.network_name && data.network_name != globalThis.networkName) throw new Error('Bad Peer NetworkName');

                        if (data && data.node_version)
                        {
                            let splitVersion = data.node_version.split(".");
                            if (parseInt(splitVersion[0]) >= 2)
                            {
                                this.peerVersions[peer] = 2;
                            }
                        }
                        else
                        {
                            this.peerVersions[peer] = 1;
                        }

                        if (!this.activePeers.includes(peer))
                            this.activePeers.push(peer);

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

                        // peer timeout or some other issue - set inactive until another peer tells us it's active again

                        const index = this.activePeers.indexOf(peer);
                        if (index > -1) {
                            this.activePeers.splice(index, 1)
                        }

                        await Peer.updateOne({url: peer}, {$set: {isActive: false, updatedAt: Date.now()}});
                        
                    }

                }

            }

        });

        this.checkingPeers = false;
        this.checkPeerLock = 0;

        return true;

    }

    public async findPeers()  {

        this.findingPeers = true;
        this.findPeerLock = Date.now();

        this.activePeers.forEach(peer => {

            (async () => {

                try {

                    const response = await axios({
                        url: peer + "/peers",
                        method: 'get',
                        responseType: 'json'
                    });

                    const data = response.data;

                    for (let i = 0; i < data.length; i++)
                    {

                        let thisPeer = data[i];

                        let stripPeer = thisPeer.replace('http://', '');
                        let splitPeer = stripPeer.split(":");

                        if (!["localhost", "127.0.0.1", this.myIpAddress].includes(splitPeer[0])) // don't peer with yourself.
                        {

                            let havePeer = await Peer.countDocuments({url: thisPeer});

                            if (havePeer === 0)
                            {

                                const peerresponse = await axios({
                                    url: thisPeer + "/name",
                                    method: 'get',
                                    responseType: 'json'
                                });
            
                                const data = peerresponse.data;

                                if (data.networkName == globalThis.networkName)
                                {

                                    await Peer.create({
                                        url: peer,
                                        ipAddress: splitPeer[0],
                                        port: splitPeer[1],
                                        lastSeen: 0,
                                        isActive: true,
                                        lastHeight: 0,
                                        networkName: globalThis.networkName,
                                        createdAt: Date.now(),
                                        updatedAt: Date.now()
                                    });

                                }
        
                            }
                            else if (havePeer === 1)
                            {

                                await Peer.updateOne({url: peer}, {$set: {isActive: true, updatedAt: Date.now()}})

                            }
                            else if (havePeer > 1)
                            {
                                // too many records for same peer - reset 
                                await Peer.deleteMany({url: peer});

                            }

                        }

                    }

                } catch (e) {

                    // peer timeout
                    
                }

            })();

        });

        this.findingPeers = false;
        this.findPeerLock = 0;

        return true;

    }

    public async downloadBlocks()  {

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

        if (maxHeight < end) end = maxHeight;

        for (let i = 0; i < this.activePeers.length; i++)
        {
            const thisPeer = this.activePeers[i];
            if (!this.queueProcessor.hasWorker(thisPeer))
            {
                this.queueProcessor.addWorker(thisPeer);
            }
        }

        let queuedCount = 0;
        for (let i = start; i <= end; i++)
        {

            if (!this.downloadedBlocks[i] && !this.queueProcessor.hasqueue(i))
            {
                this.downloadedBlocks[i] = 'pending';
                this.queueProcessor.enqueue(i);
                queuedCount++;
            }
            
        }

        this.downloadingBlocks = false;

        return true;

    }

    public async syncBlocks()  {

        globalThis.safeToShutDown = false;
        this.syncingBlocks = true;
        this.syncBlocksLock = Date.now();

        let dlBlockKeys = Object.keys(this.downloadedBlocks);

        if (dlBlockKeys.length > 0)
        {

            let nextHeight = this.myBlockHeight + 1;

            while (this.downloadedBlocks[nextHeight] && this.downloadedBlocks[nextHeight] !== 'pending')
            {

                const data = this.downloadedBlocks[nextHeight];

                try {
                    await this.importBlock(data);
                    delete this.downloadedBlocks[nextHeight];
                    nextHeight++;
                } catch (e) {
logger.warn(e);
                    delete this.downloadedBlocks[nextHeight];
                    const previousHeight = nextHeight - 1;
                    await this.doBlockRollback(previousHeight);
                    this.queueProcessor.requeue(nextHeight);
                    break;
                }
                
            }

            this.queueProcessor.requeue(nextHeight);

        }

        globalThis.safeToShutDown = true;
        this.syncingBlocks = false;
        this.syncBlocksLock = 0;

        return true;

    }

    private async doBlockRollback(height: number): Promise<boolean> {

        return new Promise<boolean>(async (resolve, reject) => {

            logger.warn("Rolling back block #" + height);

            const blockInfo = await Block.findOne({height: height}).populate("transactions");

            try {

                for (let i = 0; i < blockInfo.transactions.length; i++)
                {

                    const thisTx = blockInfo.transactions[i];

                    let fromAddress = await Address.findOne({_id: thisTx.fromAddress});

                    if (fromAddress.address !== "00000000000000000000000000000000000000000000000000" && fromAddress.address !== "")
                    {
                        await Balance.updateOne({address: thisTx.fromAddress, token: thisTx.token}, {$inc: {balance: thisTx.amount}});
                    }

                    const numbernegative = thisTx.amount * -1;
                    await Balance.updateOne({address: thisTx.toAddress, token: thisTx.token}, {$inc: {balance: numbernegative}});

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

        });

    }

    private async importBlock(block: any) {

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
                throw new Error('Invalid Block. Unexpected Height');
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
                throw new Error(e);
            }

            // Poor previous design requires this in order to sync :(
            const excludedTransactions = [
                "9B756E997F65772E54804D1373B5C6AEBB35555C61FDB0AA1AA54E47DDF1D2BE",
                "01703A6C8F63E0808FDA4BD79C773F99BDB724679009E94B6930CE8846817CDD",
                "ED1730F04A28C218BAB179DF6D577C4893519F070FA1F80B9D9D06A27DB082CE",
                "A5E0D39CDF60989D9B688A9776B3AE7B279404B21A4024A6353B0A2AC6B34486",
                "0E0084700FA9C912E7168572DDC2169944C9CF89DEC87A3DF68EE1945840D753",
                "98F834ADAAA55A9F859587F205C7A77CB6547899C2178A71CD0B98A41557FCB9",
                "F87D16EC1AAC2041D859341E4B822B9274F47F203EEE206BF5134FC70027A778",
                "0EE17D6B2FCCC7BA2C20FEF8B16F49BC62CC89EBCE2C4870B35818AB8D4C1364",
                "5A2FBD32F6B2E5D92E6DA8148E1FE3AE5F836B6010AA6B3DDAE2C07FCE4C698C",
                "21456AAE93444303FF0061396665D147D34049FF478DF6FA9F3FF50C0D8C3DA3",
                "AEE2547337F989433DD2166B2CFBC070128EB2A1A8EC7CFAFC030158ADBD3BF2",
                "28CBBCE328260875310F3445FC3EC0C162788DFA8C27BFB41BB4C0BE701C8F92",
                "74A2F60D9FB913EA9719EC218FA8F84483E1D27A913A597E33A9CD9FE093F975",
                "672B5623CF954519DDCF5FD7DF5652B0D131AD7A3B64E25C13A3CD6BC71CADB9",
                "D1A9C856D964A05AF7B4E8EFE805E3FCAAE34839C8CE9B7355EE16190128FD8C",
                "505D6E91621CC2465E0F6BBFC08800A0B4B3A8F080FF98FC8AF38E090AD6AF42",
                "A1E32D847C668C4F71574875ED085085DDBB04629001B4ACDD43417EB1E6F564",

                "7012A985AA3BF07B41EFE0417D16BEDAF4D3695C2BECEE432B09FD7AF1B65E8F",
                "06039CD789E84A7A0D09A5E9BBC9DD9EC947A1569B5B36949E4FE44EBD665E59",
                "F0B72EB45C1DF6CB19D6D5EE4F94F5F8A2C16742412FB3C2174C0306FFC905BE",
                "06039CD789E84A7A0D09A5E9BBC9DD9EC947A1569B5B36949E4FE44EBD665E59",
                "C335304F2ABE8150C5E67991CEBEA7EAFF334AB1426627857F87DF2986554306",
                "E379AC29F25F80639711F6512BEC6BF2A851605DF55DF7956E11DEA98E49CA53"
            ];

            let pendingAmounts = {};

            // Check Balances
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
                throw new Error(e);
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
                    blockIndex: i,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                }

                const newTx = await Transaction.create(newTransaction);

                await Mempool.deleteMany({hash: thisTx.txid});

                blockTx.push(newTx._id);

                if (thisTx.from !== "00000000000000000000000000000000000000000000000000" && thisTx.from !== "")
                {
                    await Balance.updateOne({address: fromAddress._id, token: tokenId}, {$inc: {balance: -transactionAmount}});
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

            }

            await Block.updateOne({_id: blockInfo._id}, {$set: {transactions: blockTx}});

            this.myBlockHeight = block.id;

            await this.updateDifficulty();

            logger.info("Imported Block #" + block.id);

            return true;

        }
        else
        {
            throw new Error('Invalid Block.');
        }

    }

    private async updateDifficulty() {

        if (this.myBlockHeight <= Constants.DIFFICULTY_LOOKBACK * 2) return;
        if (this.myBlockHeight % Constants.DIFFICULTY_LOOKBACK !== 0) return;

        const firstID: number = this.myBlockHeight - Constants.DIFFICULTY_LOOKBACK;
        const lastID: number = this.myBlockHeight;
        const first = await Block.findOne({height: firstID});
        const last = await Block.findOne({height: lastID});

        if (!first || !last) return;

        const elapsed: number = last.timestamp - first.timestamp;
        const numBlocksElapsed: number = lastID - firstID;
        const target: number = numBlocksElapsed * Constants.DESIRED_BLOCK_TIME_SEC;
        const difficulty: number = last.difficulty;
        this.difficulty = PandaniteCore.computeDifficulty(difficulty, elapsed, target);
    
        if (
          this.myBlockHeight >= Constants.PUFFERFISH_START_BLOCK &&
          this.myBlockHeight < Constants.PUFFERFISH_START_BLOCK + Constants.DIFFICULTY_LOOKBACK * 2
        ) {
          this.difficulty = Constants.MIN_DIFFICULTY;
        }

        logger.info("New Difficulty: " + this.difficulty);

        return true;

    }

    private async updateDifficultyForHeight(height: number) {

        if (height <= Constants.DIFFICULTY_LOOKBACK * 2) return;
        if (height % Constants.DIFFICULTY_LOOKBACK !== 0) return;

        const firstID: number = height - Constants.DIFFICULTY_LOOKBACK;
        const lastID: number = height;
        const first = await Block.findOne({height: firstID});
        const last = await Block.findOne({height: lastID});

        if (!first)
        {
            logger.info("Could not find first block: " + firstID);
            return;
        }

        if (!last)
        {
            logger.info("Could not find last block: " + lastID);
            return;
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

        return true;

    }

}