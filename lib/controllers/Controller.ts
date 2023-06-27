import * as mongoose from 'mongoose';
import { transactionSchema, addressSchema, balanceSchema, tokenSchema, blockSchema, peerSchema } from '../models/Model';
import { PandaniteCore } from '../core/Core'
import { Request, Response } from 'express';
import Big from 'big.js';

const Transaction = mongoose.model('Transaction', transactionSchema);
const Address = mongoose.model('Address', addressSchema);
const Balance = mongoose.model('Balance', balanceSchema);
const Token = mongoose.model('Token', tokenSchema);
const Block = mongoose.model('Block', blockSchema);
const Peer = mongoose.model('Peer', peerSchema);

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
    public async getStats (req: Request, res: Response) { 

        try {

            let stats = {
                current_block: 0,
                last_block_time: 0,
                node_version: globalThis.appVersion,
                num_coins: 0,
                num_wallets: 0,
                pending_transactions: 0,
                transactions_per_second: 0,
                mempool: []
            };

            res.json(stats);

        } catch (e) {

            res.send(e);

        }
        
    }

    // Block details by blockId
    public async getBlock (req: Request, res: Response) { 

        try {

            let block = await Block.findOne({height: req.query.blockId}); 

            if (!block) 
            {
                res.json({error: "Invalid Block"});
            }
            else
            {

                let blockinfo = {
                    difficulty: block.difficulty,
                    hash: block.hash,
                    id: block.height,
                    lastBlockHash: block.lastBlockHash,
                    merkleRoot: block.merkleRoot,
                    nonce: block.nonce,
                    timestamp: block.timestamp,
                    transactions: []
                };

                let transactions = await Transaction.find({block: block._id}).populate("fromAddress").populate("toAddress").populate("token"); 

                for (let i = 0; i < transactions.length; i++)
                {
                    let thistx = transactions[i];

                    blockinfo.transactions.push({
                        token: thistx.token.transaction,
                        amount: thistx.amount,
                        fee: thistx.fee,
                        from: thistx.fromAddress.address,
                        to: thistx.toAddress.address,
                        signature: thistx.signature,
                        signingKey: thistx.signingKey,
                        timestamp: thistx.timestamp,
                        txid:  thistx.hash
                    });
                }

                res.json(blockinfo);
            }

        } catch (e) {

            res.send(e);

        }

    }

    // Transaction Queue - Mempool
    public getTxJson (req: Request, res: Response) { 

    }

    // 
    public getMineStatus (req: Request, res: Response) { 

    }

    public getLedger (req: Request, res: Response) { 

    }

    public getWalletTransactions (req: Request, res: Response) { 

    }

    public getMine (req: Request, res: Response) { 

    }

    public getSupply (req: Request, res: Response) { 

    }

    public getNetworkHashRate (req: Request, res: Response) { 

    }

    public addPeer (req: Request, res: Response) { 

    }

    public submitBlock (req: Request, res: Response) { 

    }

    public getTx (req: Request, res: Response) { 

    }

    public getSync (req: Request, res: Response) { 

    }

    public getBlockHeaders (req: Request, res: Response) { 

    }

    public getSyncTx (req: Request, res: Response) { 

    }

    public createWallet (req: Request, res: Response) { 

    }

    public createTransaction (req: Request, res: Response) { 

    }

    public addTransaction (req: Request, res: Response) { 

    }

    public addTransactionJson (req: Request, res: Response) { 

    }

    public verifyTransaction (req: Request, res: Response) { 

    }

    /*
    public addNewContact (req: Request, res: Response) {                
        let newContact = new Contact(req.body);
    
        newContact.save((err, contact) => {
            if(err){
                res.send(err);
            }    
            res.json(contact);
        });
    }

    public getContacts (req: Request, res: Response) {           
        Contact.find({}, (err, contact) => {
            if(err){
                res.send(err);
            }
            res.json(contact);
        });
    }

    public getContactWithID (req: Request, res: Response) {           
        Contact.findById(req.params.contactId, (err, contact) => {
            if(err){
                res.send(err);
            }
            res.json(contact);
        });
    }

    public updateContact (req: Request, res: Response) {           
        Contact.findOneAndUpdate({ _id: req.params.contactId }, req.body, { new: true }, (err, contact) => {
            if(err){
                res.send(err);
            }
            res.json(contact);
        });
    }

    public deleteContact (req: Request, res: Response) {           
        Contact.remove({ _id: req.params.contactId }, (err, contact) => {
            if(err){
                res.send(err);
            }
            res.json({ message: 'Successfully deleted contact!'});
        });
    }
    */
}