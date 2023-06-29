import * as WebSocket from 'ws';
import { ApiController } from "../controllers/Controller";

export class WebSocketProcessor {
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  public startProcessing(): void {
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('error', this.handleError.bind(this));
  }

  private handleMessage(data: WebSocket.Data): void {

    try {

        console.log(data.toString());

        const message = JSON.parse(data.toString());

        console.log('Received message:', message);

        this.ws.send('OK');

    } catch (e) {

        console.log(e);

        this.ws.send('Error: Invalid JSON request');

    }

  }

  private handleError(error: Error): void {
    console.error('WebSocket error:', error);
    // Handle the error if needed
  }
}
