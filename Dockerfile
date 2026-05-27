FROM node:22-alpine

WORKDIR /app

COPY mlx-proxy.js .

CMD ["node", "mlx-proxy.js"]
