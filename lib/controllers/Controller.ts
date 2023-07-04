import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema, mempoolSchema } from '../models/Model';
import { PandaniteCore } from '../core/Core'
import { Request, Response } from 'express';
import Big from 'big.js';
import { Constants} from "../core/Constants"
import axios from 'axios';

const Transaction = mongoose.model('Transaction', transactionSchema);
const Address = mongoose.model('Address', addressSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Token = mongoose.model('Token', tokenSchema);
const Block = mongoose.model('Block', blockSchema);
const Peer = mongoose.model('Peer', peerSchema);
const Mempool = mongoose.model('Mempool', mempoolSchema);

export class ApiController{

    // Basic node information
    public getName (req: Request, res: Response) {  
        let details = {
            name: globalThis.appName,
            networkName: globalThis.networkName,
            version: globalThis.appVersion
        };             
        res.json(details)
    }

    // Sum of all works done
    public async totalWork (req: Request, res: Response) { 

        try {

            let qwork = await Block.find().sort({height: -1}).limit(1); 

            let totalwork = Big(0).toFixed(0);
            if (qwork[0] && qwork[0].totalWork)
                totalwork = Big(qwork[0].totalWork).toFixed(0);

            res.json(totalwork);

        } catch (e) {

            res.send(e);

        }

    }

    // Peers listing
    public async getPeers (req: Request, res: Response) { 

        try {

            let qpeers = await Peer.find({isActive: true}); 

            let peerlist = [];

            for (let i = 0; i < qpeers.length; i++)
            {
                peerlist.push("http://" + qpeers[i].ipAddress + ":" + qpeers[i].port);
            }

            res.json(peerlist);

        } catch (e) {

            res.send(e);

        }

    }

    // Count blocks
    public async getBlockCount (req: Request, res: Response) { 

        try {

            let blockcount = await Block.countDocuments(); 

            res.json(blockcount);

        } catch (e) {

            res.send(e);

        }

    }

    // General statistics
    public async getStats (req: Request, res: Response) { // Rest API

        const findLastBlock = await Block.find().sort({height: -1}).limit(1);
        const lastBlock = findLastBlock[0] || {};

        const qtotalcoins = await Balance.aggregate([
            {
              $match: {token: null},
            },{
              $group: {
                _id: null,
                total: {
                  $sum:  "$balance"
                }
              }
            }]
        );

        let totalcoins = Big(0).toFixed();

        if (qtotalcoins[0] && qtotalcoins[0].total)
            totalcoins = Big(qtotalcoins[0].total).div(10**4).toFixed(4);
    
        const numWallets = await Address.countDocuments();

        try {

            const stats = {
                network_name: globalThis.networkName || "mainnet",
                current_block: lastBlock.height || 0,
                last_block_time: lastBlock.timestamp || 0,
                node_version: globalThis.appVersion,
                num_coins: totalcoins,
                num_wallets: numWallets,
                pending_transactions: 0,
                transactions_per_second: 0,
                mempool: []
            };

            const memPool = await Mempool.find();

            for (let i = 0; i < memPool.length; i++)
            {
                const thistx = memPool[i];

                let tx = {
                    type: thistx.type,
                    amount: thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                };

                if (thistx.signature)
                {
                    tx["signature"] = thistx.signature;
                }

                if (thistx.signingKey)
                {
                    tx["signingKey"] = thistx.signingKey;
                }

                if (thistx.token)
                {
                    tx["token"] = thistx.token;
                    tx["tokenAmount"] = thistx.amount;
                    tx["amount"] = 0;
                }

                stats.mempool.push(tx);

            }

            res.json(stats);

        } catch (e) {

            res.send(e);

        }
        
    }

    public async getStatsWs (): Promise<any> { // Ws API

        const findLastBlock = await Block.find().sort({height: -1}).limit(1);
        const lastBlock = findLastBlock[0] || {};

        const qtotalcoins = await Balance.aggregate([
            {
              $match: {token: null},
            },{
              $group: {
                _id: null,
                total: {
                  $sum:  "$balance"
                }
              }
            }]
        );

        let totalcoins = Big(0).toFixed();

        if (qtotalcoins[0] && qtotalcoins[0].total)
            totalcoins = Big(qtotalcoins[0].total).div(10**4).toFixed(4);
    
        const numWallets = await Address.countDocuments();

        try {

            const response = {
                network_name: globalThis.networkName || "mainnet",
                current_block: lastBlock.height || 0,
                last_block_time: lastBlock.timestamp || 0,
                node_version: globalThis.appVersion,
                num_coins: totalcoins,
                num_wallets: numWallets,
                pending_transactions: 0,
                transactions_per_second: 0,
                mempool: []
            };

            const memPool = await Mempool.find();

            for (let i = 0; i < memPool.length; i++)
            {
                const thistx = memPool[i];
                
                let tx = {
                    type: thistx.type,
                    amount: thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                };

                if (thistx.signature)
                {
                    tx["signature"] = thistx.signature;
                }

                if (thistx.signingKey)
                {
                    tx["signingKey"] = thistx.signingKey;
                }

                if (thistx.token)
                {
                    tx["token"] = thistx.token;
                    tx["tokenAmount"] = thistx.amount;
                    tx["amount"] = 0;
                }

                response.mempool.push(tx);

            }

            return response;

        } catch (e) {

            const response = {
                error: {
                    code: 400,
                    message: "Unknown error has occurred"
                }
            };

            return response;

        }
        
    }

    // Block details by blockId
    public async getBlock(req: Request, res: Response) {  // Rest API

        try {

            let block = await Block.findOne({height: parseInt(req.query.blockId.toString())}); 

            if (!block) 
            {
                res.json({error: "Invalid Block"});
            }
            else
            {

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

                let transactions = await Transaction.find({block: block._id}).populate("fromAddress").populate("toAddress").populate("token").sort({blockIndex: 1}); 

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
    
                    if (thistx.token)
                    {
                        tx["token"] = thistx.token.transaction;
                        tx["tokenAmount"] = thistx.amount;
                        tx["amount"] = 0;
                    }

                    blockinfo.transactions.push(tx);

                }

                res.json(blockinfo);
            }

        } catch (e) {

            res.send(e);

        }

    }

    public async getBlockWs(blockId: number): Promise<any> { // Ws API

        try {

            let block = await Block.findOne({height: blockId}); 

            if (!block) 
            {
                const response = {
                    error: {
                        code: 404,
                        message: "Block not found"
                    }
                };
                return response;
            }
            else
            {

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

                let transactions = await Transaction.find({block: block._id}).populate("fromAddress").populate("toAddress").populate("token").sort({blockIndex: 1}); 

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
    
                    if (thistx.token)
                    {
                        tx["token"] = thistx.token.transaction;
                        tx["tokenAmount"] = thistx.amount;
                        tx["amount"] = 0;
                    }

                    blockinfo.transactions.push(tx);

                }

                return blockinfo;

            }

        } catch (e) {

            console.log(e);

            const response = {
                error: {
                    code: 400,
                    message: "Unknown error has occurred"
                }
            };

            return response;

        }

    }

    // Transaction Queue - Mempool
    public async getTxJson (req: Request, res: Response) { 

        try {

            const memPool = await Mempool.find();

            const response = [];

            for (let i = 0; i < memPool.length; i++)
            {
                const thistx = memPool[i];

                let tx = {
                    type: thistx.type,
                    amount: thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                };

                if (thistx.signature)
                {
                    tx["signature"] = thistx.signature;
                }

                if (thistx.signingKey)
                {
                    tx["signingKey"] = thistx.signingKey;
                }

                if (thistx.token)
                {
                    tx["token"] = thistx.token;
                    tx["tokenAmount"] = thistx.amount;
                    tx["amount"] = 0;
                }

                response.push(tx);

            }

            res.json(response);

        } catch (e) {

            res.json([]);

        }

    }

    public async getTxJsonWs(): Promise<any> { // Ws API

        try {

            const memPool = await Mempool.find();

            const response = [];

            for (let i = 0; i < memPool.length; i++)
            {
                const thistx = memPool[i];

                let tx = {
                    type: thistx.type,
                    amount: thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                };

                if (thistx.signature)
                {
                    tx["signature"] = thistx.signature;
                }

                if (thistx.signingKey)
                {
                    tx["signingKey"] = thistx.signingKey;
                }

                if (thistx.token)
                {
                    tx["token"] = thistx.token;
                    tx["tokenAmount"] = thistx.amount;
                    tx["amount"] = 0;
                }

                response.push(tx);

            }

            return response;

        } catch (e) {

            return [];

        }

    }

    public async peerNotifyWs(hostname: string, port: number): Promise<void> { // Ws API

        try {

            const peerUrl = "http://" + hostname + ":" + port;

            const peerresponse = await axios({
                url: peerUrl + "/name",
                method: 'get',
                responseType: 'json'
            });

            const data = peerresponse.data;

            if (data.networkName == globalThis.networkName)
            {

                let havePeer = await Peer.countDocuments({url: peerUrl});

                if (havePeer === 0)
                {

                    await Peer.create({
                        url: peerUrl,
                        ipAddress: hostname,
                        port: port,
                        lastSeen: 0,
                        isActive: true,
                        lastHeight: 0,
                        networkName: globalThis.networkName,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });

                }
                else
                {

                    await Peer.updateMany({url: peerUrl}, {$set: {isActive: true, updatedAt: Date.now()}});

                }

                console.log("received notification from new peer: " + peerUrl)

            }


        } catch (e) {

console.log(e);

        }

    }

    // input is blockId in query
    public async getMineStatus (req: Request, res: Response) { 

        let result = {};

        if (req.query.blockid)
        {
            const blockId = parseInt(req.query.blockId.toString());

            const blockInfo = await Block.findOne({height: blockId});

            if (blockInfo)
            {
                const minerTx = await Transaction.findOne({block: blockInfo._id, isGenerate: true}).populate('toAddress');

                const qfees = await Transaction.aggregate([
                    {
                      $match: {block: blockInfo._id},
                    },{
                      $group: {
                        _id: null,
                        total: {
                          $sum:  "$fee"
                        }
                      }
                    }]
                );
        
                let totalfee = Big(0).toFixed();
        
                if (qfees[0] && qfees[0].total)
                    totalfee = Big(qfees[0].total).toFixed(0);

                result["minerWallet"] = minerTx.toAddress.address;
                result["mintFee"] = minerTx.amount;
                result["txFees"] = parseInt(totalfee);
                result["timestamp"] = blockInfo.timestamp;
            }
            else
            {
                result["error"] = "Invalid Block";
            }
        }
        else
        {
            result["error"] = "Invalid Block";
        }

        res.json(result);

    }

    // Aka get balance
    public async getLedger (req: Request, res: Response) { 

        try {

            let ledgerBalance = 0;

            if (req.query.wallet && req.query.token)
            {
                const balance = await Balance.findOne({addressString: req.query.wallet.toString(), tokenString: req.query.token.toString()});
                ledgerBalance = balance?.balance || 0;
                let tokenString = balance?.tokenString || "";

                res.json({balance: ledgerBalance, token: tokenString, type: 'token'});
            }
            else if (req.query.wallet)
            {
                const balance = await Balance.findOne({addressString: req.query.wallet.toString(), token: null});
                ledgerBalance = balance?.balance || 0;

                res.json({balance: ledgerBalance, type: 'native'});
            }

        } catch (e) {

            res.json({balance: 0});

        }

    }

    public async getWalletTransactions (req: Request, res: Response) { 

        try {

            if (!req.query.wallet)
            {
                res.json({error: "No query parameters specified"});
                return;
            }

            const walletAddress = String(req.query.wallet).toUpperCase();

            const addressInfo = await Address.findOne({address: walletAddress});

            if (!addressInfo)
            {
                res.json([]);
                return;
            }

            const txList = await Transaction.find({$or: [{toAddress: addressInfo._id}, {fromAddress: addressInfo._id}]}).populate("block").sort({createdAt: -1});

            let response = [];

            for (let i = 0; i < txList.length; i++)
            {
                const txInfo = txList[i];

                let tx = {
                    type: txInfo.type,
                    amount: txInfo.amount,
                    fee: txInfo.fee,
                    from: txInfo.fromAddress.address,
                    to: txInfo.toAddress.address,
                    timestamp: txInfo.nonce,
                    nonce: txInfo.nonce,
                    txid:  txInfo.hash,
                    blockHeight: txInfo.block.height,
                    blockIndex: txInfo.blockIndex,
                    isGenerate: txInfo.isGenerate
                };

                if (txInfo.signature)
                {
                    tx["signature"] = txInfo.signature;
                }

                if (txInfo.signingKey)
                {
                    tx["signingKey"] = txInfo.signingKey;
                }

                if (txInfo.token)
                {
                    tx["token"] = txInfo.token?.transaction;
                    tx["tokenAmount"] = txInfo.amount;
                    tx["amount"] = 0;
                }

                response.push(tx);

            }

            res.json(response);

        } catch (e) {

            res.json([]);

        }

    }

    public async getMine (req: Request, res: Response) { 

        const result = {};

        try {

            const lastBlock = await Block.find().sort({height: -1}).limit(1); 

            const chainHeight = lastBlock[0]?.height || 0;

            const lastDiffHeight = Math.floor(chainHeight/Constants.DIFFICULTY_LOOKBACK)*Constants.DIFFICULTY_LOOKBACK;


            if (lastDiffHeight <= Constants.DIFFICULTY_LOOKBACK * 2) return;
            if (lastDiffHeight % Constants.DIFFICULTY_LOOKBACK !== 0) return;

            const firstID: number = lastDiffHeight - Constants.DIFFICULTY_LOOKBACK;
            const lastID: number = lastDiffHeight;
            const first = await Block.findOne({height: firstID});
            const last = await Block.findOne({height: lastID});

            let thisdifficulty: number;

            if (!first)
            {
                thisdifficulty = 16; // default
            }
            else if (!last)
            {
                thisdifficulty = 16; // default
            }
            else
            {
                const elapsed: number = last.timestamp - first.timestamp;
                const numBlocksElapsed: number = lastID - firstID;
                const target: number = numBlocksElapsed * Constants.DESIRED_BLOCK_TIME_SEC;
                const difficulty: number = last.difficulty;
                thisdifficulty = PandaniteCore.computeDifficulty(difficulty, elapsed, target);
            
                if (
                    lastDiffHeight >= Constants.PUFFERFISH_START_BLOCK &&
                    lastDiffHeight < Constants.PUFFERFISH_START_BLOCK + Constants.DIFFICULTY_LOOKBACK * 2
                ) {
                    thisdifficulty = Constants.MIN_DIFFICULTY;
                }
            }

            result["lastHash"] = lastBlock[0]?.blockHash;
            result["challengeSize"] = thisdifficulty;
            result["chainLength"] = chainHeight;
            result["miningFee"] = PandaniteCore.getCurrentMiningFee(chainHeight);
            result["lastTimestamp"] = lastBlock[0]?.timestamp;

        } catch (e) {

            console.log(e);

            result["error"] = "An error occurred";

        }
        
        res.json(result);

    }

    public async getSupply (req: Request, res: Response) { 

        try {

            const qtotalcoins = await Balance.aggregate([
                {
                $match: {token: null},
                },{
                $group: {
                    _id: null,
                    total: {
                    $sum:  "$balance"
                    }
                }
                }]
            );

            let totalcoins = Big(0).toFixed();

            if (qtotalcoins[0] && qtotalcoins[0].total)
                totalcoins = Big(qtotalcoins[0].total).div(10**4).toFixed(4);

            res.json(Number(totalcoins));

        } catch (e) {

            res.json(0);

        }

    }

    public async getNetworkHashRate (req: Request, res: Response) { 

        try {

            const lastBlock = await Block.find().sort({height: -1}).limit(1); 

            const blockCount = lastBlock[0]?.height || 0;

            let totalWork: number = 0;
        
            const blockStart: number = blockCount < 52 ? 2 : blockCount - 50;
            const blockEnd: number = blockCount;
        
            let start: number = 0;
            let end: number = 0;

            const blockStats = await Block.aggregate([
                {
                $match: {height: {$gte: blockStart, $lte: blockEnd}},
                },{
                $sort : { height : 1 }
                },{
                $group: {
                    _id: null,
                    total: {
                    $sum:  {$pow : [2, "$difficulty"]}
                    },
                    first: {
                        $first: "$timestamp"
                    },
                    last: {
                        $last: "$timestamp"
                    }
                }
                }]
            );

            totalWork = blockStats[0].total;
            start = blockStats[0].first;
            end = blockStats[0].last;

            const hashRate = totalWork / (end - start);

            res.json(hashRate);

        } catch (e) {

            res.json(0);

        }

    }

    // JSON body post
    public async addPeer (req: Request, res: Response) { 

        try {

            let peerInfo = JSON.parse(req.body);

console.log("got call to post /add_peer");
console.log(peerInfo);

            if (!peerInfo.networkName) peerInfo.networkName = 'mainnet';

            if (globalThis.networkName !== peerInfo.networkName) return;

            let thisPeer = peerInfo.address;

            let stripPeer = thisPeer.replace('http://', '');
            let splitPeer = stripPeer.split(":");

            if (!["localhost", "127.0.0.1"].includes(splitPeer[0])) // don't peer with yourself.
            {

                let havePeer = await Peer.countDocuments({url: thisPeer});

                if (havePeer == 0)
                {

                    await Peer.create({
                        url: thisPeer,
                        ipAddress: splitPeer[0],
                        port: splitPeer[1],
                        lastSeen: 0,
                        isActive: true,
                        lastHeight: 0,
                        networkName: peerInfo.networkName,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });

                }

            }

        } catch (e) {


        }

        /*
                    if (!peerInfo.contains("networkName")) peerInfo["networkName"] = "mainnet";
                    json result = manager.addPeer(peerInfo["address"], peerInfo["time"], peerInfo["version"], peerInfo["networkName"]);
                    res->writeHeader("Content-Type", "application/json; charset=utf-8")->end(result.dump());
        */
    }

    public submitBlock (req: Request, res: Response) { 




    }

    public getSync (req: Request, res: Response) { 

        console.log("getSync REST endpoint called")
        //console.log(req.body);

        /*

            if (req->getQuery("start").length() == 0 || req->getQuery("end").length() == 0) {
                json err;
                err["error"] = "No query parameters specified";
                res->writeHeader("Content-Type", "application/json; charset=utf-8")->end(err.dump());
                return;
            }
            int start = std::stoi(string(req->getQuery("start")));
            int end = std::stoi(string(req->getQuery("end")));
            if ((end-start) > BLOCKS_PER_FETCH) {
                Logger::logError("/v2/sync", "invalid range requested");
                res->end("");
            }
            res->writeHeader("Content-Type", "application/octet-stream");
            for (int i = start; i <=end; i++) {
                std::pair<uint8_t*, size_t> buffer = manager.getRawBlockData(i);
                std::string_view str((char*)buffer.first, buffer.second);
                res->write(str);
                delete buffer.first;
            }
            res->end("");

        */

    }

    // octect stream
    public getBlockHeaders (req: Request, res: Response) { 

        console.log("getBlockHeaders REST endpoint called")
        //console.log(req.body);

    }

    // same endpoints /gettx /synctx   -- returns octet stream of mempool tx data
    public getSyncTx (req: Request, res: Response) { 

        console.log("getSyncTx REST endpoint called")
        //console.log(req.body);

        //res->writeHeader("Content-Type", "application/octet-stream");
        //std::pair<char*, size_t> buffer = manager.getRawTransactionData();

        /*

            std::pair<char*, size_t> MemPool::getRaw() const{
                std::unique_lock<std::mutex> lock(mempool_mutex);
                size_t len = transactionQueue.size() * TRANSACTIONINFO_BUFFER_SIZE;
                char* buf = (char*) malloc(len);
                int count = 0;
                
                for (const auto& tx : transactionQueue) {
                    TransactionInfo t = tx.serialize();
                    transactionInfoToBuffer(t, buf + count);`
                    count += TRANSACTIONINFO_BUFFER_SIZE;
                }

                return std::make_pair(buf, len);
            }



            void transactionInfoToBuffer(TransactionInfo& t, char* buffer) {
                writeNetworkNBytes(buffer, t.signature, 64);
                writeNetworkNBytes(buffer, t.signingKey, 32);
                writeNetworkUint64(buffer, t.timestamp);    // 8
                writeNetworkPublicWalletAddress(buffer, t.to);  //25
                writeNetworkUint64(buffer, t.amount);   // 8
                writeNetworkUint64(buffer, t.fee);    // 8
                uint32_t flag = 0;
                if (t.isTransactionFee) flag = 1;
                writeNetworkUint32(buffer, flag);    // 4
            }



        */

    }

    public createWallet (req: Request, res: Response) { 

        let newWallet;

        if (req.query.password)
        {
            let password = req.query.password.toString();
            newWallet = PandaniteCore.generateNewAddress(password);
        }
        else
        {
            newWallet = PandaniteCore.generateNewAddress("");
        }

        res.json(newWallet);

    }

    // json body - post
    public createTransaction (req: Request, res: Response) { 






    }

    // binary - peers
    public addTransaction (req: Request, res: Response) { 

        console.log("addTransaction REST endpoint called")
        console.log(req.body);

    }

    // json body
    public addTransactionJson (req: Request, res: Response) { 

        console.log("addTransactionJson REST endpoint called")
        console.log(req.body);
    }

    // get tx list status and blockid - this should be depricated
    public async verifyTransaction (req: Request, res: Response) { 

        try {

            const inputList = req.body;

            const inputArray = JSON.parse(inputList);

            const txDbList = [];
            
            for (let i = 0; i < inputArray.length; i++)
            {
                const thisItem = inputArray[i];
                if (thisItem.txid) txDbList.push(thisItem.txid)
            }

            const txList = await Transaction.find({txid: txDbList}).populate('block');

            const foundTx = {};

            for (let i = 0; i < txList.length; i++)
            {
                const thistx = txList[i];

                foundTx[thistx.txid] = {
                    txid: thistx.txid,
                    status: "IN_CHAIN",
                    blockId: thistx.block.height
                };
            }

            const response = [];

            for (let i = 0; i < inputArray.length; i++)
            {
                const thisItem = inputArray[i];
                if (thisItem.txid) 
                {
                    if (foundTx[thisItem.txid])
                    {
                        response.push(foundTx[thisItem.txid]);
                    }
                    else
                    {
                        response.push({txid: thisItem.txid, status: "NOT_IN_CHAIN"});
                    }
                }
            }

            return response;

        } catch (e) {
            return {
                error: "An Error Occurred"
            };
        }

    }

    // NEW API Endpoints

    // Get single onchain tx rest api
    public async getTransaction (req: Request, res: Response) { 

        if (!req.query || !req.query.txid) {
            return {
                error: "Transaction Not Found"
            };
        }

        const lastBlock = await Block.find().sort({height: -1}).limit(1);
        const lastBlockHeight = lastBlock[0]?.height || 0;

        const txInfo = await Transaction.findOne({txid: req.query.txid.toString()}).populate('block').populate("fromAddress").populate("toAddress").populate("token");

        if (txInfo)
        {

            let response = {
                type: txInfo.type,
                amount: txInfo.amount,
                fee: txInfo.fee,
                from: txInfo.fromAddress.address,
                to: txInfo.toAddress.address,
                signature: txInfo.signature,
                signingKey: txInfo.signingKey,
                timestamp: txInfo.nonce,
                nonce: txInfo.nonce,
                txid:  txInfo.hash,
                blockHeight: txInfo.block.height,
                blockIndex: txInfo.blockIndex,
                confirmations: lastBlockHeight - txInfo.block.height,
                isGenerate: txInfo.isGenerate
            };

            if (txInfo.signature)
            {
                response["signature"] = txInfo.signature;
            }

            if (txInfo.signingKey)
            {
                response["signingKey"] = txInfo.signingKey;
            }

            if (txInfo.token)
            {
                response["token"] = txInfo.token.transaction;
                response["tokenAmount"] = txInfo.amount;
                response["amount"] = 0;
            }

            return response;

        }
        else
        {
            return {
                error: "Transaction Not Found"
            };
        }

    }

}