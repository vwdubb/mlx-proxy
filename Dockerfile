FROM node:22-alpine

WORKDIR /app

COPY package.json mlx-proxy.js ./

CMD ["node", "mlx-proxy.js"]
