import app from './app';
import * as minimist from 'minimist';
import * as WebSocket from 'ws';
import * as http from 'http';
import { WebSocketProcessor } from './routes/WebSocketProcessor';
import { createLogger, format, transports } from 'winston';
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

const argv = minimist(process.argv.slice(1));

const PORT = argv.port || 3000;

globalThis.appPort = PORT;
globalThis.appVersion = '2.0.0';
globalThis.appName = argv.name || 'Pandanite Node';
globalThis.networkName = argv.network || 'mainnet';
globalThis.defaultPeers = ["http://31.220.88.229:3000","http://88.119.161.26:3000","http://161.97.102.112:3000","http://88.119.169.111:3000","http://88.119.161.26:3001", "http://31.220.88.229:3001"]; // last 2 are v2
globalThis.shuttingDown = false;
globalThis.safeToShutdown = true;
globalThis.maxPeers = 20;

const server = http.createServer(app);

const wss = new WebSocket.WebSocketServer({ noServer: true });

interface ExtWebSocket extends WebSocket {
    isAlive: boolean;
}

server.on('upgrade', function upgrade(request, socket, head) {
    wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', function connection(ws) {
    const processor = new WebSocketProcessor(ws);
    processor.startProcessing();
    const extWs = ws as ExtWebSocket;
    extWs.isAlive = true;
    ws.on('error', console.error);
    ws.on('pong', function() {
        const extWs = this as ExtWebSocket;
        extWs.isAlive = true;
    });
});

const wsinterval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        const extWs = ws as ExtWebSocket;
        if (extWs.isAlive === false) return ws.terminate();
        extWs.isAlive = false;
        ws.ping();
    });
}, 30000);
  
process.on('SIGINT', function() {

	globalThis.shuttingDown = true;

    clearInterval(wsinterval);
	
	return new Promise((resolve, reject) => {
    
		var shutdowncheck = setInterval(function() {
			
			logger.warn('Checking if shutdown is safe... ' + globalThis.safeToShutdown.toString());

			if (globalThis.safeToShutdown == true)
			{
				process.exit(0);
			}
  
		}, 1000);

	});
	
});

process.on('uncaughtException', err => {
    console.log('uncaughtException!! shutting down...');
    console.log(err);
    process.exit(1);
}); 

server.listen(PORT, () => {

    console.log(`    @*******************************************************************************`);
    console.log(`                                Pandanite Node v` + globalThis.appVersion);
    console.log(`    @*******************************************************************************
    @*******************************************************************************
    @*******************************************************************************
    @*******************************************************************************
    @*******************************************************************************
    @*******************************************************************************
    @***********,%%%%%%%%&****************** ***************** %%%%%%%%%************
    @******** %%%%%%%%%%%%%%.***/             *,,.     *****%%%%%%%%%%%%%%%*********
    @******* %%%%%%%%%%%%%%%%%                            %%%%%%%%%%%%%%%%%#********
    @*******,%%%%%%%%%%%%%%%%                              %%%%%%%%%%%%%%%% ********
    @*******/%%%%%%%%%%%%%%                                  %%%%%%%%%%%%%% ********
    @********,%%%%%%%%%%(                                       %%%%%%%%%% *********
    @********** %%%%%%                                            %%%%%%%***********
    @***************                                                 ***************
    @*************              %%%%%               %%%%              **************
    @*************        &%%%%%%%%%%%            %%%%%%%%%%%%         *************
    @************         %%@  %%   %%%          %%%  #%   *%%         *************
    @************        .%%  %%%%%  %%%        &%%% #%%%%  %%%        *************
    @************        %%%%      %%%            %%&      %%%%        *************
    @************         %%%%%%%%%%%              .%%%%%%%%%%         *************
    @************          %%%%%%%%                  %%%%%%%%          *************
    @************            %%%%%                     %%%%            *************
    @*************                                                    ,*************
    @*************                      %%%%%%%%(                     **************
    @****************                                              *****************
    @******************                                          *******************
    @**********************             %%%%%%%%#            ***********************
    @*****************************                    .*****************************
    @***********************************        ************************************
    @*******************************************************************************
    @*******************************************************************************
    @*******************************************************************************`);

    logger.info('Pandanite node listening on port ' + PORT);
})