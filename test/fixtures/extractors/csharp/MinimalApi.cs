// Minimal APIs: MapGroup prefixes carry through variables and chains, and same-file
// constants are resolved.
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

const string Todos = "/todos";

var api = app.MapGroup("/api").WithTags("api");
var orders = api.MapGroup("orders");

orders.MapGet("/{id}", (int id) => id); // seam: route GET /api/orders/{}
app.MapGroup("/v2").MapPost("/items", () => Results.Created()); // seam: route POST /v2/items
app.MapGet(Todos, () => 1); // seam: route GET /todos
app.MapDelete("/todos/{id}", (int id) => Results.NoContent()); // seam: route DELETE /todos/{}

app.Run();
