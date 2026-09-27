FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY .env.example ./
VOLUME ["/app/data", "/app/state"]
EXPOSE 8787
CMD ["node", "src/index.js"]
