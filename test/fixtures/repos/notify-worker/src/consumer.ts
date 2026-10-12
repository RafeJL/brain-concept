export async function listen(channel: Channel) {
  await channel.consume("OrderStartedIntegrationEvent", (message) => sendConfirmation(message));
  await channel.consume(process.env.EXTRA_QUEUE!, (message) => log(message));
}
