public class OrderingService(IEventBus eventBus)
{
    public async Task StartOrder(Order order)
    {
        await eventBus.PublishAsync(new OrderStartedIntegrationEvent(order.Id));
    }

    public async Task ChangeStatus(Order order)
    {
        await eventBus.PublishAsync(new OrderStatusChangedIntegrationEvent(order.Id, order.Status));
    }
}
