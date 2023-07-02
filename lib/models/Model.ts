import * as mongoose from 'mongoose';

const Schema = mongoose.Schema;

/*
* txtypes proposed: 0 = transfer, 1 = transfertoken, 2 = createtoken, 3 = minttoken, 4 = transfertokenowner
*/
export const transactionSchema = new Schema({
    type: {
        type: Number,
        defaultsTo: 0
    },
    toAddress: {
        type: Schema.Types.ObjectId,
        ref: 'Address'
    },
    fromAddress: {
        type: Schema.Types.ObjectId,
        ref: 'Address'
    },
    signature: {
        type: String            
    },
    hash: {
        type: String
    },
    amount: {
        type: Number,
        defaultsTo: 0        
    },
    token: {
        type: Schema.Types.ObjectId,
        ref: 'Token'
    },
    fee: {
        type: Number,
        defaultsTo: 0
    },
    isGenerate: {
        type: Boolean,
        defaultsTo: false
    },
    nonce: {
        type: String
    },
    signingKey: {
        type: String
    },
    block: {
        type: Schema.Types.ObjectId,
        ref: 'Block',
    },
    blockIndex: {
        type: Number
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

transactionSchema.index({ toAddress: 1 });
transactionSchema.index({ fromAddress: 1 });
transactionSchema.index({ hash: 1 });
transactionSchema.index({ block: 1 });

export const addressSchema = new Schema({
    address: {
        type: String
    },
    publicKey: {
        type: String
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

addressSchema.index({ address: 1 });

export const balanceSchema = new Schema({
    address: {
        type: Schema.Types.ObjectId,
        ref: 'Address',
    },
    token: {
        type: Schema.Types.ObjectId,
        ref: 'Token'
    },
    addressString: {
        type: String
    },
    tokenString: {
        type: String
    },
    balance: {
        type: Number
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

balanceSchema.index({ token: 1 });
balanceSchema.index({ address: 1, token: 1 });
balanceSchema.index({ addressString: 1, token: 1 });
balanceSchema.index({ addressString: 1, tokenString: 1 });

export const tokenSchema = new Schema({
    ownerAddress: {
        type: Schema.Types.ObjectId,
        ref: 'Address',
    },
    transaction: {
        type: Schema.Types.ObjectId,
        ref: 'Transaction'
    },
    tokenId: {
        type: String
    },
    name: {
        type: String
    },
    ticker: {
        type: String
    },
    circulation: {
        type: Number
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

tokenSchema.index({ ownerAddress: 1 });
tokenSchema.index({ transaction: 1 });
tokenSchema.index({ tokenId: 1 });


export const blockSchema = new Schema({
    nonce: {
        type: String
    },
    height: {
        type: Number
    },
    totalWork: {
        type: String
    },
    difficulty: {
        type: Number
    },
    timestamp: {
        type: Number
    },
    merkleRoot: {
        type: String
    },
    blockHash: {
        type: String
    },
    lastBlockHash: {
        type: String
    },
    transactions: [{
        type: Schema.Types.ObjectId,
        ref: 'Transaction'
    }],
    blockReward: {
        type: Number
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

blockSchema.index({ height: 1 });
blockSchema.index({ blockHash: 1 });


export const peerSchema = new Schema({
    url: {
        type: String
    },
    ipAddress: {
        type: String
    },
    port: {
        type: Number
    },
    lastSeen: {
        type: Number,
        default: Date.now
    },
    isActive: {
        type: Boolean
    },
    lastHeight: {
        type: Number
    },
    networkName: {
        type: String
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

peerSchema.index({ ipAddress: 1, port: 1 });
peerSchema.index({ url: 1 });
peerSchema.index({ isActive: 1 });

/*
* txtypes proposed: 0 = transfer, 1 = transfertoken, 2 = createtoken, 3 = minttoken, 4 = transfertokenowner
*/
export const mempoolSchema = new Schema({
    type: {
        type: Number,
        defaultsTo: 0
    },
    to: {
        type: String 
    },
    from: {
        type: String 
    },
    signature: {
        type: String            
    },
    hash: {
        type: String
    },
    amount: {
        type: Number,
        defaultsTo: 0        
    },
    token: {
        type: String
    },
    fee: {
        type: Number,
        defaultsTo: 0
    },
    nonce: {
        type: String
    },
    signingKey: {
        type: String
    },
    createdAt: {
        type: Number,
        default: Date.now
    },
    updatedAt: {
        type: Number,
        default: Date.now
    }
});

mempoolSchema.index({ hash: 1 });
mempoolSchema.index({ from: 1 });
