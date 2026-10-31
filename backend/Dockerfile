FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Expose backend port
EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000

# Start backend using existing start script in package.json
CMD ["npm", "start"]
