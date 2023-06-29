import * as WebSocket from 'ws';
import { ApiController } from "../controllers/Controller";

export class WebSocketProcessor {
  private ws: WebSocket;
  private apiSrv: ApiController = new ApiController();

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  public startProcessing(): void {
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('error', this.handleError.bind(this));
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {

    try {

        console.log(data.toString());

        const message = JSON.parse(data.toString());

        let response = {};

        switch (message.method) {
            case 'getBlock':
                if (message.blockId && parseInt(message.blockId) > 0)
                {
                    let data = await this.apiSrv.getBlockWs(message.blockId);
                    if (!data.error) 
                    {
                        response = {
                            statusCode: 200,
                            data: data
                        };
                    }
                    else
                    {
                        response = {
                            statusCode: 400,
                            error: data.error
                        };
                    }
                }
                else
                {
                    response = {
                        statusCode: 400,
                        error: {
                            code: 401,
                            message: "Missing method argument"
                        }
                    };
                }
                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            case 'getStats':
                let data = await this.apiSrv.getStatsWs();
                if (!data.error) 
                {
                    response = {
                        statusCode: 200,
                        data: data
                    };
                }
                else
                {
                    response = {
                        statusCode: 400,
                        error: data.error
                    };
                }
                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            case 'getVersion':

                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            case 'getMempool':

                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            case 'newBlock':

                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            case 'newTransaction':

                this.ws.send(this.formatReponse(response, message.messageId));
                break;
            default:
                response = {
                    statusCode: 400,
                    error: {
                        code: 404,
                        message: "Unknown Method"
                    }
                };
                this.ws.send(this.formatReponse(response, message.messageId));
        }

    } catch (e) {

        console.log(e);

        let response = {
            statusCode: 400,
            error: {
                code: 400,
                message: "Unknown Error"
            }
        };
        this.ws.send(this.formatReponse(response, null));

    }

  }

  private formatReponse(json: any, messageId: any): string {

    json.messageId = messageId;
    return JSON.stringify(json);

  }

  private handleError(error: Error): void {
    console.error('WebSocket error:', error);
    // Handle the error if needed
  }
}
