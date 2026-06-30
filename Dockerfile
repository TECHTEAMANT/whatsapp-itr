# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist

# Install required system dependencies for Baileys/Node crypto features
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
