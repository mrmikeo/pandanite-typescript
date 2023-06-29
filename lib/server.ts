import app from './app';
import * as fs from 'fs';
import * as minimist from 'minimist';
import * as WebSocket from 'ws';
import * as http from 'http';
import { WebSocketProcessor } from './routes/WebSocketProcessor';

const argv = minimist(process.argv.slice(1));

const PORT = argv.port || 3000;

globalThis.appVersion = '2.0.0';
globalThis.appName = argv.name || 'Pandanite Node';
globalThis.networkName = argv.network || 'mainnet';
globalThis.defaultPeers = ["http://5.9.151.50:3000","http://65.21.224.171:3000","http://65.21.89.182:3000","http://88.119.169.111:3000","http://88.119.161.26:3001"]; // last one is v2
globalThis.shuttingDown = false;
globalThis.safeToShutdown = true;

const server = http.createServer(app);

const wss = new WebSocket.WebSocketServer({ noServer: true });

server.on('upgrade', function upgrade(request, socket, head) {

    wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit('connection', ws, request);
    });

});

wss.on('connection', function connection(ws) {
    const processor = new WebSocketProcessor(ws);
    processor.startProcessing();
    ws.send("Connected to " + globalThis.appName + " v" + globalThis.appVersion);
});

process.on('SIGINT', function() {

	globalThis.shuttingDown = true;
	
	return new Promise((resolve, reject) => {
    
		var shutdowncheck = setInterval(function() {
			
			console.log('Checking if shutdown is safe... ' + globalThis.safeToShutdown.toString());

			if (globalThis.safeToShutdown == true)
			{
				process.exit(0);
			}
  
		}, 1000);

	});
	
});

server.listen(PORT, () => {

    console.log(`    Pandanite Node v` + globalThis.appVersion);
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

    console.log('Pandanite node listening on port ' + PORT);
})