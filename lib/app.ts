import * as express from "express";
import * as bodyParser from "body-parser";
import { Routes } from "./routes/Routes";
import * as mongoose from "mongoose";
import { PandaniteJobs } from './core/Jobs';
import helmet from 'helmet';
import * as cors from 'cors';

class App {

    public app: express.Application = express();
    public routePrv: Routes = new Routes();
    public mongoUrl: string = 'mongodb://localhost/pandanitenode';  
    public jobsPrv: PandaniteJobs = new PandaniteJobs();

    constructor() {
        this.config();
        this.mongoSetup();
        this.routePrv.routes(this.app);        
        this.jobsPrv.syncPeers(); 
    }

    private config(): void{
        this.app.use(helmet());
        this.app.use(cors());
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: false }));
        // serving static files 
        this.app.use(express.static('public'));
    }

    private mongoSetup(): void{
        mongoose.connect(this.mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true, useCreateIndex: true });        
    }

}

export default new App().app;
