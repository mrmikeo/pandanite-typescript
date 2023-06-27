import { PandaniteCore } from './Core'
import axios from 'axios';
import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema } from '../models/Model';
import Big from 'big.js';

const Transaction = mongoose.model('Transaction', transactionSchema);
const Address = mongoose.model('Address', addressSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Token = mongoose.model('Token', tokenSchema);
const Block = mongoose.model('Block', blockSchema);
const Peer = mongoose.model('Peer', peerSchema);

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
      console.log(`Worker ${hostname} processing item: ${item}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
    queueProcessor: QueueProcessor<number>;

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
        this.queueProcessor = new QueueProcessor<number>();
    }

    public syncPeers() {

        // start jobs for syncing peers list & blocks

        const workerFunction: Worker<number> = async (thisPeer, height) => {

            try {

                //console.log(thisPeer + ":" + height);
                
                const response = await axios({
                    url: thisPeer + "/block?blockId=" + height,
                    method: 'get',
                    responseType: 'json'
                });
    
                const data = response.data;
    
                if (data && data.hash)
                {
                    this.downloadedBlocks[height] = response.data;
                    //console.log("Downloaded block #" + height);
                }
                else
                {
                    const index = this.activePeers.indexOf(thisPeer);
                    if (index > -1) {
                        this.activePeers.splice(index, 1);
                    }
                    delete this.downloadedBlocks[height];
                    this.queueProcessor.removeWorker(thisPeer);
                    this.queueProcessor.enqueue(height);
                }
    
            } catch (e) {
    
                const index = this.activePeers.indexOf(thisPeer);
                if (index > -1) {
                    this.activePeers.splice(index, 1);
                }
    
                delete this.downloadedBlocks[height];
                this.queueProcessor.removeWorker(thisPeer);
                this.queueProcessor.enqueue(height);
    
            }
            
        };

        // Start the queue processor
        this.queueProcessor.addFunction(workerFunction);

        this.checkPeers();

        let that = this;

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

    public async printPeeringInfo() {

        console.log("----===== Active Peers =====----");

        const myHeight = await Block.find().sort({height: -1}).limit(1);

        let height = 0;
        if (myHeight.length > 0) height = myHeight[0].height;

        console.log("My BlockHeight: " + height);

        for (let i = 0; i < this.activePeers.length; i++)
        {
            console.log(this.activePeers[i] + " - BlockHeight: " + this.peerHeights[this.activePeers[i]]);
        }

    }

    public async checkPeers() {

        this.checkingPeers = true;
        this.checkPeerLock = Date.now();

        let peerList = await Peer.find({isActive: true});

        for (let i = 0; i < peerList.length; i++)
        {
            let thisPeer = peerList[i];
            if (this.pendingPeers.indexOf("http://" + thisPeer.ipAddress + ":" + thisPeer.port) === -1)
                this.pendingPeers.push("http://" + thisPeer.ipAddress + ":" + thisPeer.port);
        }

        if (this.pendingPeers.length === 0)
        {
            this.pendingPeers = globalThis.defaultPeers;
        }

        this.pendingPeers.forEach(peer => {

//console.log(peer);

            (async () => {

                try {

                    const response = await axios.get(peer + "/block_count");

                    const data = response.data;

//console.log(data);

                    if (parseInt(data) === 0) throw new Error('Bad Peer');

                    if (this.activePeers.indexOf(peer) === -1)
                        this.activePeers.push(peer);

                    let havePeer = await Peer.findOne({url: peer});

                    this.peerHeights[peer] = parseInt(data);

                    if (!havePeer)
                    {

                        let stripPeer = peer.replace('http://', '');
                        let splitPeer = stripPeer.split(":");

                        await Peer.create({
                            url: peer,
                            ipAddress: splitPeer[0],
                            port: splitPeer[1],
                            lastSeen: Date.now(),
                            isActive: true,
                            lastHeight: parseInt(data),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });

                    }
                    else
                    {
                        await Peer.updateOne({url: peer}, {$set: {
                            lastSeen: Date.now(),
                            isActive: true,
                            lastHeight: parseInt(data),
                            updatedAt: Date.now()
                        }});
                    }
                    

                } catch (e) {
                    // peer timeout

                    const index = this.activePeers.indexOf(peer);
                    if (index > -1) {
                        this.activePeers.splice(index, 1)
                    }

                    await Peer.updateOne({url: peer}, {$set: {isActive: false}});
                    
                }

            })();

        });

        this.checkingPeers = false;
        this.checkPeerLock = 0;

    }

    public async findPeers() {

        this.findingPeers = true;
        this.findPeerLock = Date.now();

        this.activePeers.forEach(peer => {

//console.log(peer);

            (async () => {

                try {


                    const response = await axios({
                        url: peer + "/peers",
                        method: 'get',
                        responseType: 'json'
                    });

                    const data = response.data;

//console.log(data);
                    for (let i = 0; i < data.length; i++)
                    {

                        let thisPeer = data[i];

                        let havePeer = await Peer.findOne({url: thisPeer});

                        if (!havePeer)
                        {
    
                            let stripPeer = thisPeer.replace('http://', '');
                            let splitPeer = stripPeer.split(":");
    
                            await Peer.create({
                                url: peer,
                                ipAddress: splitPeer[0],
                                port: splitPeer[1],
                                lastSeen: 0,
                                isActive: true,
                                lastHeight: 0,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            });
    
                        }

                    }

                } catch (e) {
                    // peer timeout
                    
                }

            })();

        });

        this.findingPeers = false;
        this.findPeerLock = 0;

    }

    public async downloadBlocks() {

        this.downloadingBlocks = true;

        const myHeight = await Block.find().sort({height: -1}).limit(1);

        let height = 0;
        if (myHeight.length > 0) height = myHeight[0].height;

        let start = height + 1;
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

//console.log("Queued " + queuedCount + " new items");

        this.downloadingBlocks = false;

    }

    public async syncBlocks() {

        globalThis.safeToShutDown = false;
        this.syncingBlocks = true;
        this.syncBlocksLock = Date.now();

        let dlBlockKeys = Object.keys(this.downloadedBlocks);

        if (dlBlockKeys.length > 0)
        {

            // What is my height?

            const myHeight = await Block.find().sort({height: -1}).limit(1);

            let height = 0;
            if (myHeight.length > 0) height = myHeight[0].height;

            // Is next height downloaded?

            let nextHeight = height + 1;

            while (this.downloadedBlocks[nextHeight] && this.downloadedBlocks[nextHeight] !== 'pending')
            {

                const data = this.downloadedBlocks[nextHeight];

                try {
                    await this.importBlock(data);
                    delete this.downloadedBlocks[nextHeight];
                    nextHeight++;
                } catch (e) {
                    console.log(e);
                    delete this.downloadedBlocks[nextHeight];
                    const previousHeight = nextHeight - 1;
                    await this.doBlockRollback(previousHeight);
                }
                
            }

            this.queueProcessor.requeue(nextHeight);

        }
        else
        {

            console.log("syncBlocks: No Blocks Downloaded");

        }

        globalThis.safeToShutDown = true;
        this.syncingBlocks = false;
        this.syncBlocksLock = 0;

    }

    private async doBlockRollback(height: number)
    {

        console.log("Rolling back block #" + height);

        const blockInfo = await Block.findOne({height: height}).populate("transactions");

        try {

            for (let i = 0; i < blockInfo.transactions.length; i++)
            {

                const thisTx = blockInfo.transactions[i];

                let fromAddress = await Address.findOne({_id: thisTx.fromAddress});

                if (fromAddress.address !== "00000000000000000000000000000000000000000000000000" && fromAddress.address !== "")
                {
                    await Balance.updateOne({address: thisTx.fromAddress, token: null}, {$inc: {balance: thisTx.amount}});
                }

                const numbernegative = thisTx.amount * -1;
                await Balance.updateOne({address: thisTx.toAddress, token: null}, {$inc: {balance: numbernegative}});

                await Transaction.deleteOne({_id: thisTx._id});

            }

            await Block.deleteOne({_id: blockInfo._id});

        } catch (e) {

            // in case of fail above, then we should start over

            console.log(blockInfo);

            console.log(e);

            console.log("Caught error on rollback.  EXIT")

            process.exit(-1);

            //await Block.deleteMany();
            //await Transaction.deleteMany();
            //await Balance.deleteMany();
            //await Token.deleteMany();

        }

        return true;

    }

    private async importBlock(block: any)
    {

        const lastBlock = await Block.find().sort({height: -1}).limit(1);

        let lastHeight = 0;
        let isValid = false;

        if (lastBlock.length > 0)
        {
            lastHeight = lastBlock[0].height;
            let expectedHeight = lastHeight + 1;

            if (block.id != expectedHeight)
            {
                throw new Error('Invalid Block. Unexpected Height');
            }

            try {
                isValid = PandaniteCore.checkBlockValid(block, lastBlock[0].blockHash, lastBlock[0].height, false);
            } catch (e) {
                console.log(e);
                throw new Error('Invalid Block.');
            }
        }
        else if (block.id === 1)
        {

            try {
                isValid = PandaniteCore.checkBlockValid(block, "0000000000000000000000000000000000000000000000000000000000000000", 0, false);
            } catch (e) {
                throw new Error('Invalid Block.');
            }

        }

        if (isValid === true)
        {

            const totalWork = Big(lastBlock[0].totalWork).plus(block.difficulty).toFixed(0);

            // add block to db

            const newBlock = {
                nonce: block.nonce,
                height: block.id,
                totalWork: totalWork,
                difficulty: block.difficulty,
                timestamp: block.timestamp,
                merkleRoot: block.merkleRoot,
                blockHash: block.hash,
                lastBlockHash: block.lastBlockHash,
                transactions: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            const blockInfo = await Block.create(newBlock);

            let blockTx = [];

            for (let i = 0; i < block.transactions.length; i++)
            {

                const thisTx = block.transactions[i];

                let toAddress = await Address.findOne({address: thisTx.to});
                let fromAddress = await Address.findOne({address: thisTx.from});

                if (!toAddress)
                {
                    toAddress = await Address.create({
                        address: thisTx.to,
                        publicKey: "",
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                }

                if (!fromAddress)
                {
                    fromAddress = await Address.create({
                        address: thisTx.from,
                        publicKey: "",
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                }
                const newTransaction = {
                    toAddress: toAddress._id,
                    fromAddress: fromAddress._id,
                    signature: thisTx.signature,
                    hash: thisTx.txid,
                    amount: thisTx.amount,
                    token: null,
                    fee: thisTx.fee,
                    isGenerate: thisTx.from===""?true:false,
                    timestamp: thisTx.timestamp,
                    signingKey: thisTx.signingKey,
                    block: blockInfo._id,
                    blockIndex: i,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                }

                const newTx = await Transaction.create(newTransaction);

                blockTx.push(newTx._id);

                if (thisTx.from !== "00000000000000000000000000000000000000000000000000" && thisTx.from !== "")
                {
                    const numbernegative = thisTx.amount * -1;
                    await Balance.updateOne({address: fromAddress._id, token: null}, {$inc: {balance: numbernegative}});
                }

                const haveToBalance = await Balance.findOne({address: toAddress._id, token: null});

                if (!haveToBalance)
                {
                    await Balance.create({
                        address: toAddress._id,
                        token: null,
                        balance: thisTx.amount,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });

                }
                else
                {
                    await Balance.updateOne({address: toAddress._id, token: null}, {$inc: {balance: thisTx.amount}});
                }

            }

            await Block.updateOne({_id: blockInfo._id}, {$set: {transactions: blockTx}});

            console.log("Imported Block #" + block.id);

        }
        else
        {
            throw new Error('Invalid Block.');
        }

    }

}