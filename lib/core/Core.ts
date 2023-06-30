import * as ed25519 from 'ed25519';
import * as _ from 'underscore';
import * as crypto from 'crypto'
import { pufferFish } from './Pufferfish'
import { Constants} from "./Constants"

const unhexlify = function(str: string) { 
    var result = [];
    while (str.length >= 2) { 
      result.push(parseInt(str.substring(0, 2), 16));
      str = str.substring(2, str.length);
    }
    return new Uint8Array(result);
}

const dec2hex = function(str: string) { 
    var dec = [];
    dec = str.toString().split('');
    var sum = [];
    var hex = [];
    while(dec.length){
        let s = 1 * dec.shift()
        for(let i = 0; s || i < sum.length; i++){
            s += (sum[i] || 0) * 10
            sum[i] = s % 16
            s = (s - sum[i]) / 16
        }
    }
    while(sum.length){
        hex.push(sum.pop().toString(16))
    }
    return hex.join('')
}

class HashTree {
    parent: HashTree | null;
    left: HashTree | null;
    right: HashTree | null;
    hash: string;
  
    constructor(hash: string) {
      this.parent = null;
      this.left = null;
      this.right = null;
      this.hash = hash;
    }
}

class MerkleTree {
    root: HashTree | null;
    fringeNodes: { [hash: string]: HashTree };
  
    constructor() {
      this.root = null;
      this.fringeNodes = {};
    }
  
    // Destructor is not needed in TypeScript
  
    setItems(items: any): void {

        items.sort((a, b) => {
            return a.hash > b.hash ? -1 : 1;
        });

        const q: HashTree[] = [];
        for (const item of items) {
            const h = item.hash;
            this.fringeNodes[h] = new HashTree(h);
            q.push(this.fringeNodes[h]);
        }
    
        if (q.length % 2 === 1) {
            const repeat = new HashTree(q[q.length - 1].hash);
            q.push(repeat);
        }

        while (q.length > 1) {
            const a = q.shift()!;
            const b = q.shift()!;
            const root = new HashTree(Constants.NULL_SHA256_HASH);
            root.left = a;
            root.right = b;
            a.parent = root;
            b.parent = root;
            root.hash = crypto.createHash('sha256').update(unhexlify(a.hash)).update(unhexlify(b.hash)).digest().toString('hex');
            q.push(root);
        }

        this.root = q[0];
    }
  
    getRootHash(): string | null {
      return this.root ? this.root.hash : null;
    }
  
    getMerkleProof(t: any): HashTree | null {
      const hash = t.hash;
      const iterator = this.fringeNodes[hash];
      if (!iterator) return null;
      return this.getProof(iterator);
    }

    getProof(fringe: HashTree, previousNode: HashTree | null = null): HashTree {
        const result = new HashTree(fringe.hash);
      
        if (previousNode !== null) {
          if (fringe.left && fringe.left !== previousNode) {
            result.left = fringe.left;
            result.right = previousNode;
          } else if (fringe.right && fringe.right !== previousNode) {
            result.right = fringe.right;
            result.left = previousNode;
          }
        }
      
        if (fringe.parent) {
          return this.getProof(fringe.parent, fringe);
        } else {
          return result;
        }
    }
}

export class PandaniteCore{

    static async checkBlockValid(block: any, lastBlockHash: string, lastBlockHeight: number, expectedDifficulty: number, networkTimestamp: number, medianTimestamp: number): Promise<boolean> {

        return new Promise<boolean>((resolve, reject) => {

            // Check Block ID
            if (block.id != lastBlockHeight + 1)
            {
                reject("Invalid Block Height: " + block.id);
            }

            // Check transactions size
            const blockTxSize = block.transactions.length;
            if (blockTxSize > Constants.MAX_TRANSACTIONS_PER_BLOCK)
            {
                reject("Invalid Transaction Count: " + blockTxSize);
            }

            // Validate Block Difficulty
            if (block.difficulty != expectedDifficulty)
            {
                reject("Invalid Block Difficulty: " + block.difficulty + ", Expected: " + expectedDifficulty);
            }

            // Validate Block Time
            if (block.id !== 1) {

                // block must be less than 2 hrs into the future from network time
                const maxTime: number = networkTimestamp + (120 * 60)
                if (block.timestamp > maxTime)
                {
                    reject("Block Timestamp Too Far Into Future");
                }
              
                // block must be after the median timestamp of last 10 blocks
                if (medianTimestamp > 0) {
                    if (block.timestamp < medianTimestamp)
                    {
                        reject("Block Timestamp Too Old");
                    }
                }
            }

            // Validate Transactions in Block
            for (let i = 0; i < blockTxSize; i++)
            {
                const thisTx = block.transactions[i];
                const isValid = PandaniteCore.validateTransaction(thisTx);
                if (isValid === false) 
                {
                    reject("checkBlockHash failed at Validate Transaction");
                }
            }

            // Validate MerkleTree
            const expectedMerkleHash = block.merkleRoot;
            const actualMerkleHash = PandaniteCore.checkMerkleTree(block.transactions);

            if (expectedMerkleHash !== actualMerkleHash) {
                reject("checkBlockHash failed at Validate MerkleTree " + actualMerkleHash + " != " + expectedMerkleHash);
            }

            // Validate Blockhash
            const expectedBlockHash = block.hash;
            const actualBlockHash = PandaniteCore.getBlockHash(block).toUpperCase();

            if (expectedBlockHash !== actualBlockHash) {
                reject("checkBlockHash failed at Validate Blockhash " + actualBlockHash + " != " + expectedBlockHash);
            }

            // Check Nonce
            const validNonce = PandaniteCore.verifyNonce(block);
            if (validNonce === false)
            {
                reject("Invalid Block Nonce: " + block.nonce);
            }

            resolve(true);

        });

    }

    static checkMerkleTree(items: any): string {
        // generate hash
        for (let i = 0; i < items.length; i++)
        {
            items[i].hash = PandaniteCore.getTransactionHash(items[i], true);
        }
        let merkleTree = new MerkleTree();
        merkleTree.setItems(items);
        const root = merkleTree.getRootHash();
        // return merkleroot hash
        return root.toUpperCase();
    }

    static validateTransaction(transaction: any): boolean {
        if (transaction.from == "" || transaction.from == "00000000000000000000000000000000000000000000000000") return true;
        const txId = PandaniteCore.getTransactionId(transaction);
        return PandaniteCore.verifyTransactionSignature(txId, transaction.signingKey, transaction.signature);
    }

    static signMessage(message: string, publicKey: string, privateKey: string) {
    
        try {
            const keyPair = {
                publicKey: Buffer.from(publicKey, 'hex'),
                privateKey: Buffer.from(privateKey, 'hex')
            }
            let signature = ed25519.Sign(Buffer.from(message, 'utf8'), keyPair);
            return signature.toString();
        } catch (e) {
            return false;
        }
    }

    static signTransaction(txid: string, publicKey: string, privateKey: string) {
        try {
            const keyPair = {
                publicKey: Buffer.from(publicKey, 'hex'),
                privateKey: Buffer.from(privateKey, 'hex')
            }
            let signature = ed25519.Sign(Buffer.from(txid, 'hex'), keyPair);
            return signature.toString();
        } catch (e) {
            return false;
        }
    }

    static verifyTransactionSignature(txid: string, publicKey: string, signature: string) {
        return ed25519.Verify(Buffer.from(txid, 'hex'), Buffer.from(signature, 'hex'), Buffer.from(publicKey, 'hex'));  
    }

    static verifyMessage(message: string, publicKey: string, signature: string) {
        return ed25519.Verify(Buffer.from(message, 'utf8'), Buffer.from(signature, 'hex'), Buffer.from(publicKey, 'hex'));
    }

    static getTransactionId(transaction: any): string {
        const pad = function(n: string, width: number, z: string) {
            z = z || '0';
            n = n + '';
            return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
          }

        const tx = {
            "from": transaction.from, 
            "to": transaction.to, 
            "fee": transaction.fee,
            "amount": transaction.amount, 
            "timestamp": transaction.timestamp,
            "token": transaction.token,
            "signature": transaction.signature
        };

        let ctx = crypto.createHash('sha256');

        ctx.update(unhexlify(tx.to));

        ctx.update(unhexlify(tx.from));

        let hexfee = Buffer.from(pad(dec2hex(tx.fee), 16, '0'), 'hex');
        let hexfeea = Buffer.from(hexfee).toJSON().data;
        hexfeea.reverse();
        let swapfee = Buffer.from(hexfeea).toString('hex');
        ctx.update(unhexlify(swapfee));


        let hexamount = Buffer.from(pad(dec2hex(tx.amount), 16, '0'), 'hex');
        let hexamounta = Buffer.from(hexamount).toJSON().data;
        hexamounta.reverse();
        let swapamount = Buffer.from(hexamounta).toString('hex');
        ctx.update(unhexlify(swapamount));

        let hextimestamp = Buffer.from(pad(dec2hex(tx.timestamp), 16, '0'), 'hex');
        let hextimestampa = Buffer.from(hextimestamp).toJSON().data;
        hextimestampa.reverse();
        let swaptimestamp = Buffer.from(hextimestampa).toString('hex');
        ctx.update(unhexlify(swaptimestamp));

        if (tx.token)
        {

            ctx.update(unhexlify(tx.token));

        }

        return ctx.digest().toString('hex');
    }

    static getTransactionHash(transaction: any, withsignature: boolean): string {
        let ctx = crypto.createHash('sha256');

        ctx.update(unhexlify(PandaniteCore.getTransactionId(transaction)));

        if (withsignature === true && transaction.signature)
        {

            ctx.update(unhexlify(transaction.signature));

        }

        return ctx.digest().toString('hex');
    }

    static getBlockHash(block: any): string {
        const pad = function(n: string, width: number, z: string) {
            z = z || '0';
            n = n + '';
            return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
          }

        let ctx = crypto.createHash('sha256');

        ctx.update(unhexlify(block.merkleRoot));

        ctx.update(unhexlify(block.lastBlockHash));

        let hexdiff = Buffer.from(pad(dec2hex(block.difficulty), 8, '0'), 'hex');
        let hexdiffa = Buffer.from(hexdiff).toJSON().data;
        hexdiffa.reverse();
        let swapdiff = Buffer.from(hexdiffa).toString('hex');
        ctx.update(unhexlify(swapdiff));

        let hextimestamp = Buffer.from(pad(dec2hex(block.timestamp), 16, '0'), 'hex');
        let hextimestampa = Buffer.from(hextimestamp).toJSON().data;
        hextimestampa.reverse();
        let swaptimestamp = Buffer.from(hextimestampa).toString('hex');
        ctx.update(unhexlify(swaptimestamp));

        return ctx.digest().toString('hex');
    }

    static verifyNonce(block: any): boolean {
        const blockHash = PandaniteCore.getBlockHash(block);

        const usePufferfish = block.id > Constants.PUFFERFISH_START_BLOCK;

        const target = this.getBlockHash(block);

        if (usePufferfish)
        {
            return PandaniteCore.verifyPufferHash(target, block.nonce, block.difficulty);
        }
        else
        {
            return PandaniteCore.verifySha256Hash(target, block.nonce, block.difficulty);
        }
    }

    static verifyPufferHash(target: string, nonce: string, difficulty: number): boolean {
        const buffers = [unhexlify(target), unhexlify(nonce)];
        const newBuffer = Buffer.concat(buffers);
        const pufferHash = pufferFish.PUFFERFISH(newBuffer, newBuffer.length);
        return PandaniteCore.checkLeadingZeroBits(pufferHash, difficulty);
    }

    static verifySha256Hash(target: string, nonce: string, difficulty: number): boolean {
        const concatHashes = crypto.createHash('sha256').update(unhexlify(target)).update(unhexlify(nonce)).digest().toString('hex');
        return PandaniteCore.checkLeadingZeroBits(concatHashes, difficulty);
    }

    static checkLeadingZeroBits(hash: string, challengeSize: number): boolean {
        const bytes: number = Math.floor(challengeSize / 8);
        const a: Uint8Array = unhexlify(hash);
        
        for (let i = 0; i < bytes; i++) {
          if (a[i] !== 0) return false;
        }
        
        const remainingBits: number = challengeSize - 8 * bytes;
        
        if (remainingBits > 0) return (a[bytes] >> (8 - remainingBits)) === 0;
        else return true;
    }

    static computeDifficulty(currentDifficulty: number, elapsedTime: number, expectedTime: number): number {

        let newDifficulty: number = currentDifficulty;

        if (elapsedTime > expectedTime) {
          let k: number = 2;
          let lastK: number = 1;
      
          while (newDifficulty > Constants.MIN_DIFFICULTY) {
            if (Math.abs(elapsedTime / k - expectedTime) > Math.abs(elapsedTime / lastK - expectedTime)) {
              break;
            }
      
            newDifficulty--;
            lastK = k;
            k *= 2;
          }
      
          return newDifficulty;
        } else {
          let k: number = 2;
          let lastK: number = 1;
      
          while (newDifficulty < 254) {
            if (Math.abs(elapsedTime * k - expectedTime) > Math.abs(elapsedTime * lastK - expectedTime)) {
              break;
            }
      
            newDifficulty++;
            lastK = k;
            k *= 2;
          }
      
          return newDifficulty;
        }
    }

}