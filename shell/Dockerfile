FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Run as node
CMD ["node", "watch-containers.js"]
