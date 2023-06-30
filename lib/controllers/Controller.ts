import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema, mempoolSchema } from '../models/Model';
import { PandaniteCore } from '../core/Core'
import { Request, Response } from 'express';
import Big from 'big.js';
import { find } from 'underscore';

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
                stats.mempool.push({
                    type: thistx.type,
                    token: thistx.token,
                    tokenAmount: thistx.token?thistx.amount:null,
                    amount: thistx.token?0:thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    signature: thistx.signature,
                    signingKey: thistx.signingKey,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                });
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
                response.mempool.push({
                    type: thistx.type,
                    token: thistx.token,
                    tokenAmount: thistx.token?thistx.amount:null,
                    amount: thistx.token?0:thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    signature: thistx.signature,
                    signingKey: thistx.signingKey,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                });
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

                    blockinfo.transactions.push({
                        type: thistx.type,
                        token: thistx.token?.transaction,
                        tokenAmount: thistx.token?thistx.amount:null,
                        amount: thistx.token?0:thistx.amount,
                        fee: thistx.fee,
                        from: thistx.fromAddress.address,
                        to: thistx.toAddress.address,
                        signature: thistx.signature,
                        signingKey: thistx.signingKey,
                        timestamp: thistx.nonce,
                        nonce: thistx.nonce,
                        txid:  thistx.hash
                    });
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

                    blockinfo.transactions.push({
                        type: thistx.type,
                        token: thistx.token?.transaction,
                        tokenAmount: thistx.token?thistx.amount:null,
                        amount: thistx.token?0:thistx.amount,
                        fee: thistx.fee,
                        from: thistx.fromAddress.address,
                        to: thistx.toAddress.address,
                        signature: thistx.signature,
                        signingKey: thistx.signingKey,
                        timestamp: thistx.nonce,
                        nonce: thistx.nonce,
                        txid:  thistx.hash
                    });
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

                response.push({
                    type: thistx.type,
                    token: thistx.token,
                    tokenAmount: thistx.token?thistx.amount:null,
                    amount: thistx.token?0:thistx.amount,
                    fee: thistx.fee,
                    from: thistx.from,
                    to: thistx.to,
                    signature: thistx.signature,
                    signingKey: thistx.signingKey,
                    timestamp: thistx.nonce,
                    nonce: thistx.nonce,
                    txid:  thistx.hash
                });
            }

            res.json(response);

        } catch (e) {

            res.json([]);

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
                ledgerBalance = balance.balance;
            }
            else if (req.query.wallet)
            {
                const balance = await Balance.findOne({addressString: req.query.wallet.toString(), token: null});
                ledgerBalance = balance.balance;
            }

            res.json({balance: ledgerBalance});

        } catch (e) {

            res.json({balance: 0});

        }

    }

    public getWalletTransactions (req: Request, res: Response) { 

    }

    public getMine (req: Request, res: Response) { 

    }

    public getSupply (req: Request, res: Response) { 

    }

    public getNetworkHashRate (req: Request, res: Response) { 

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

    // returns octet stream
    public getTx (req: Request, res: Response) { 

    }

    public getSync (req: Request, res: Response) { 

    }

    public getBlockHeaders (req: Request, res: Response) { 

    }

    public getSyncTx (req: Request, res: Response) { 

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

    // json body
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

            const response = {
                type: txInfo.type,
                token: txInfo.token?.transaction,
                tokenAmount: txInfo.token?txInfo.amount:null,
                amount: txInfo.token?0:txInfo.amount,
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