import basket_pb2_grpc

stub = basket_pb2_grpc.BasketStub(channel)


def load(buyer_id):
    return stub.GetBasket(basket_pb2.GetBasketRequest(id=buyer_id))
