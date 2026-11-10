FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node broker ./broker
COPY --chown=node:node shared ./shared
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 BRIDGE_DATA=/app/data
EXPOSE 8787
CMD ["node", "broker/server.js"]
