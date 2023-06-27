import { Request, Response, NextFunction } from "express";
import { ApiController } from "../controllers/Controller";

export class Routes { 
    
    public apiController: ApiController = new ApiController() 
    
    public routes(app): void {   

        // Name 
        app.route('/name')
        .get(this.apiController.getName) 

        app.route('/total_work')
        .get(this.apiController.totalWork) 

        app.route('/peers')
        .get(this.apiController.getPeers) 

        app.route('/block_count')
        .get(this.apiController.getBlockCount) 

        app.route('/stats')
        .get(this.apiController.getStats) 

        app.route('/block')
        .get(this.apiController.getBlock) 

        app.route('/tx_json')
        .get(this.apiController.getTxJson) 

        app.route('/mine_status')
        .get(this.apiController.getMineStatus) 

        app.route('/ledger')
        .get(this.apiController.getLedger) 

        app.route('/wallet_transactions')
        .get(this.apiController.getWalletTransactions) 

        app.route('/mine')
        .get(this.apiController.getMine) 

        app.route('/supply')
        .get(this.apiController.getSupply) 

        app.route('/getnetworkhashrate')
        .get(this.apiController.getNetworkHashRate) 

        app.route('/gettx')
        .get(this.apiController.getTx) 

        app.route('/sync')
        .get(this.apiController.getSync) 

        app.route('/block_headers')
        .get(this.apiController.getBlockHeaders) 

        app.route('/synctx')
        .get(this.apiController.getSyncTx) 

        app.route('/create_wallet')
        .get(this.apiController.createWallet) 



        app.route('/add_peer')
        .post(this.apiController.addPeer) 

        app.route('/submit')
        .post(this.apiController.submitBlock) 

        app.route('/create_transaction')
        .post(this.apiController.createTransaction) 

        app.route('/add_transaction')
        .post(this.apiController.addTransaction)

        app.route('/add_transaction_json')
        .post(this.apiController.addTransactionJson)

        app.route('/verify_transaction')
        .post(this.apiController.verifyTransaction)


        /*
        app.route('/')
        .get((req: Request, res: Response) => {            
            res.status(200).send({
                message: 'GET request successfulll!!!!'
            })
        })
        
        // Contact 
        app.route('/contact')
        .get((req: Request, res: Response, next: NextFunction) => {
            // middleware
            console.log(`Request from: ${req.originalUrl}`);
            console.log(`Request type: ${req.method}`);            
            if(req.query.key !== '78942ef2c1c98bf10fca09c808d718fa3734703e'){
                res.status(401).send('You shall not pass!');
            } else {
                next();
            }                        
        }, this.apiController.getContacts)        

        // POST endpoint
        .post(this.apiController.addNewContact);

        // Contact detail
        app.route('/contact/:contactId')
        // get specific contact
        .get(this.apiController.getContactWithID)
        .put(this.apiController.updateContact)
        .delete(this.apiController.deleteContact)
        */

    }
}