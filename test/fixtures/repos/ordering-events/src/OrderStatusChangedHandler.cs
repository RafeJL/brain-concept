public class OrderStatusChangedHandler : IIntegrationEventHandler<OrderStatusChangedIntegrationEvent>
{
    public Task Handle(OrderStatusChangedIntegrationEvent @event) => Task.CompletedTask;
}
