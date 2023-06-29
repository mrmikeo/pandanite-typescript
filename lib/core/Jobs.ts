import { PandaniteCore } from './Core'
import axios from 'axios';
import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema } from '../models/Model';
import Big from 'big.js';
import { Constants } from "./Constants"
import * as minimist from 'minimist';
import * as WebSocket from 'ws';

const Transaction = mongoose.model('Transaction', transactionSchema);
const Address = mongoose.model('Address', addressSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Token = mongoose.model('Token', tokenSchema);
const Block = mongoose.model('Block', blockSchema);
const Peer = mongoose.model('Peer', peerSchema);

axios.defaults.timeout === 3000;

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

    public async syncPeers()  {

        const argv = minimist(process.argv.slice(1));

        if (argv.reset === true) // reset chain
        {
            await Block.deleteMany();
            await Transaction.deleteMany();
            await Balance.deleteMany();
            await Token.deleteMany();
            await Peer.deleteMany();
            console.log("Chain is reset");
        }

        if (argv.resetpeers === true) // reset chain
        {
            await Peer.deleteMany();
            console.log("Peers is reset");
        }

        const response = await axios.get('http://api.ipify.org/')
        console.log("My public IP address is: " + response.data);
        this.myIpAddress = response.data;

        // start jobs for syncing peers list & blocks

        const workerFunction: Worker<number> = async (thisPeer, height) => {

            try {

                if (this.peerHeights[thisPeer] >= height)
                {
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
                this.queueProcessor.enqueue(height);
    
            }

        };

        // Start the queue processor
        this.queueProcessor.addFunction(workerFunction);

        const myHeight = await Block.find().sort({height: -1}).limit(1);

        let height = 0;
        if (myHeight.length > 0) height = myHeight[0].height;

        this.myBlockHeight = height;

console.log("My block height is " + height);

        const lastDiffHeight = Math.floor(height/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

console.log("Last diff height is " + lastDiffHeight);

        await this.updateDifficultyForHeight(lastDiffHeight);

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

    public stringToHex(str: string) {
        let hexString = '';
        for (let i = 0; i < str.length; i++) {
          const hex = str.charCodeAt(i).toString(16);
          hexString += hex.padStart(2, '0');
        }
        return hexString;
    }

    public async printPeeringInfo() {

        console.log("----===== Active Peers (" + this.activePeers.length + ") =====----");

        console.log("BlockHeight: " + this.myBlockHeight);
        console.log("Difficulty: " + this.difficulty);

        for (let i = 0; i < this.activePeers.length; i++)
        {
            let thisPeerHeight = this.peerHeights[this.activePeers[i]] || 0;
            let thisPeerVersion = this.peerVersions[this.activePeers[i]] || 1;
            console.log(this.activePeers[i] + " - BlockHeight: " + thisPeerHeight + " - Version: " + thisPeerVersion);
        }

        console.log("-----------------------------------");

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
            if (this.pendingPeers.indexOf("http://" + thisPeer.ipAddress + ":" + thisPeer.port) === -1)
                this.pendingPeers.push("http://" + thisPeer.ipAddress + ":" + thisPeer.port);
        }

        if (this.pendingPeers.length === 0)
        {
            this.pendingPeers = globalThis.defaultPeers;
        }

        this.pendingPeers.forEach(async (peer) => {

            if (this.peerVersions[peer] === 2) // PEER VERSION 2
            {

                // Known peer of version 2
                if (this.websocketPeers[peer])
                {
                    // check if websocket is still open
                    if (this.websocketPeers[peer].readyState === WebSocket.OPEN)
                    {
                        
                        // get stats

                        const messageId = this.stringToHex(peer) + "." + Date.now();

                        const message = {
                            method: 'getStats',
                            messageId: messageId
                        };

                        let respFunc = async (peer: string, messageId: string, data: string) => {

                            try {

                                const jsonparse = JSON.parse(data);
                                const jsondata = jsonparse.data;

console.log("V2 getStats Result");
console.log(jsondata);

                                if (!jsondata || parseInt(jsondata.current_block) === 0) throw new Error('Bad Peer');

                                that.peerVersions[peer] = 2; // assumed since this is ws
        
                                if (that.activePeers.indexOf(peer) === -1)
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
console.log(e);
                                delete that.wsRespFunc[messageId];
                            }

                        };

                        this.wsRespFunc[messageId] = respFunc;

                        this.websocketPeers[peer].send(JSON.stringify(message));
                        
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

                            const messageId = that.stringToHex(peer) + "." + Date.now();

                            const message = {
                                method: 'getStats',
                                messageId: messageId
                            };

                            const respFunc = async (peer: string, messageId: string, data: string) => {

                                try {

                                    const jsonparse = JSON.parse(data);
                                    const jsondata = jsonparse.data;

console.log("V2 getStats Result");
console.log(jsondata);

                                    if (!jsondata || parseInt(jsondata.current_block) === 0) throw new Error('Bad Peer');

                                    that.peerVersions[peer] = 2; // assumed since this is ws
            
                                    if (that.activePeers.indexOf(peer) === -1)
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
console.log(e);
                                    delete that.wsRespFunc[messageId];
                                }

                            };

                            that.wsRespFunc[messageId] = respFunc;

                            this.send(JSON.stringify(message));

                        }
                        
                        client.on('message', function message(data) {

                            try {

                                const jsondata = JSON.parse(data.toString());
                                if (that.wsRespFunc[jsondata.messageId])
                                {

                                    that.wsRespFunc[jsondata.messageId](peer, jsondata.messageId, data.toString());

                                }

                            } catch (e) {

console.log(e);

                            }
                        });

                        client.on('close', function close() {

                            console.log('ws disconnected from peer: ' + peer);

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

console.log(e);

                    }

                }

            }
            else // PEER VERSION 1
            {

                try {

                    const response = await axios.get(peer + "/stats");
                    const data = response.data;

                    if (!data || parseInt(data.current_block) === 0) throw new Error('Bad Peer');

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

                    if (this.activePeers.indexOf(peer) === -1)
                        this.activePeers.push(peer);

                    this.peerHeights[peer] = parseInt(data.current_block);

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
                            lastHeight: parseInt(data.current_block),
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
                            lastHeight: parseInt(data.current_block),
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

                    // peer timeout or some other issue

                    const index = this.activePeers.indexOf(peer);
                    if (index > -1) {
                        this.activePeers.splice(index, 1)
                    }

                    await Peer.updateOne({url: peer}, {$set: {isActive: false}});
                    
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

                        let stripPeer = thisPeer.replace('http://', '');
                        let splitPeer = stripPeer.split(":");

                        if (["localhost", "127.0.0.1", this.myIpAddress].indexOf(splitPeer[0]) == -1) // don't peer with yourself.
                        {

                            let havePeer = await Peer.countDocuments({url: thisPeer});

                            if (havePeer == 0)
                            {

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
                    console.log(e);
                    delete this.downloadedBlocks[nextHeight];
                    const previousHeight = nextHeight - 1;
                    await this.doBlockRollback(previousHeight);
                    this.queueProcessor.requeue(nextHeight);
                    break;
                }
                
            }

        }

        globalThis.safeToShutDown = true;
        this.syncingBlocks = false;
        this.syncBlocksLock = 0;

        return true;

    }

    private async doBlockRollback(height: number): Promise<boolean> {

        return new Promise<boolean>(async (resolve, reject) => {

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

                this.myBlockHeight = height - 1;

                const lastDiffHeight = Math.floor(this.myBlockHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;

                await this.updateDifficultyForHeight(lastDiffHeight);
    
                resolve(true);

            } catch (e) {

                // in case of fail above, then we should start over or at least run a recompute on the chain...

                console.log(blockInfo);

                console.log(e);

                console.log("Caught error on rollback.  EXIT")

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

            try {
                isValid = await PandaniteCore.checkBlockValid(block, lastBlock.blockHash, lastBlock.height, this.difficulty, networkTimestamp, medianTimestamp);
            } catch (e) {
                console.log(e);
                throw new Error(e);
            }

        }
        else if (block.id === 1)
        {

            let medianTimestamp = 0;
            let networkTimestamp = Math.round(Date.now()/1000);

            try {
                isValid = await PandaniteCore.checkBlockValid(block, "0000000000000000000000000000000000000000000000000000000000000000", 0, this.difficulty, networkTimestamp, medianTimestamp);
            } catch (e) {
                console.log(e);
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

            this.myBlockHeight = block.id;

            await this.updateDifficulty();

            console.log("Imported Block #" + block.id);

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

        console.log("New Difficulty: " + this.difficulty);

        return true;

    }

    private async updateDifficultyForHeight(height: number) {

        if (height <= Constants.DIFFICULTY_LOOKBACK * 2) return;
        if (height % Constants.DIFFICULTY_LOOKBACK !== 0) return;

        const firstID: number = height - Constants.DIFFICULTY_LOOKBACK;
        const lastID: number = height;
        const first = await Block.findOne({height: firstID});
        const last = await Block.findOne({height: lastID});

        if (!first || !last) return;

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

        console.log("New Difficulty: " + this.difficulty);

        return true;

    }
}