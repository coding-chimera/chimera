--!strict
-- Class-like forms: metatable OOP, constructors, methods, inheritance chain.

local Shape = {}
Shape.__index = Shape

function Shape.new(name: string, sides: number): Shape
	local self = setmetatable({}, Shape)
	self.name = name
	self.sides = sides
	return self
end

function Shape:area(): number
	return 0
end

function Shape:describe(): string
	return self.name .. " with " .. tostring(self.sides) .. " sides"
end

local Square = setmetatable({}, { __index = Shape })
Square.__index = Square

function Square.new(side: number): Square
	local self = Shape.new("square", 4)
	self = setmetatable(self, Square)
	self.side = side
	return self
end

function Square:area(): number
	return self.side * self.side
end

local shape = Shape.new("blob", 0)
local square = Square.new(3)
print(shape:describe(), shape:area())
print(square:describe(), square:area())

export type ShapeLike = {
	name: string,
	sides: number,
	area: (self: ShapeLike) -> number,
}

return { Shape = Shape, Square = Square }
