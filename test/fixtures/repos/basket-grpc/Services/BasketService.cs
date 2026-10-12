public class BasketService : Basket.BasketBase
{
    public override Task<CustomerBasketResponse> GetBasket(GetBasketRequest request, ServerCallContext context)
        => Task.FromResult(new CustomerBasketResponse());

    public override Task<DeleteBasketResponse> DeleteBasket(DeleteBasketRequest request, ServerCallContext context)
        => Task.FromResult(new DeleteBasketResponse());
}
