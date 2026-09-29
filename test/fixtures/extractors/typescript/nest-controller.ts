import { Controller, Get, Post } from "@nestjs/common";

// NestJS: the class prefix and the method decorator combine; the seam cites the method.
@Controller("cats")
export class CatsController {
  @Get(":id")
  findOne() {} // seam: route GET /cats/{}

  @Post()
  create() {} // seam: route POST /cats
}
