# Pandanite Crypto - Typescript

This is a rewrite of pandanite node from c++ into typescript

DO NOT TRY TO USE THIS UNLESS YOU ARE PART OF THE TESTING TEAM.  THIS PROGRAM IS INCOMPLETE AND NOT EVEN CLOSE TO BEING READY FOR PRODUCTION USE.

## Instal MongoDB

https://www.digitalocean.com/community/tutorials/how-to-install-mongodb-on-ubuntu-20-04

## Install NodeJS (Developed on version 20)

https://www.digitalocean.com/community/tutorials/how-to-install-node-js-on-ubuntu-22-04#option-3-installing-node-using-the-node-version-manager

## Clone this repository

```
git clone https://github.com/mrmikeo/pandanite-typescript
```

Then install the dependencies

```
npm install
```

## Start the server

Run in development mode

```
npm run dev
```

Run in production mode 

```
npm run prod
```

## Available CLI arguments

```
--reset :: reset chain
--port 3000 :: set port to 3000
--name test :: set node name to test
--network mainnet :: set node network to mainnet
```

Usage:
```
npm run dev -- --port 3000 --name test
```