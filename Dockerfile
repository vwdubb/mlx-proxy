FROM node:22-alpine

WORKDIR /app

COPY package.json llm-proxy.js ./

CMD ["node", "llm-proxy.js"]
