FROM node:22-slim
WORKDIR /app
COPY package*.json ./
# `prepare` builds on install, so the sources must be there first.
COPY . .
RUN npm ci && npm prune --omit=dev && rm -rf web/node_modules
ENV KG_HOST=0.0.0.0 KG_PORT=7777 KG_DB=/data/graph.db
VOLUME /data
EXPOSE 7777
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/cli.js", "serve"]
