import * as O from "https://raw.githubusercontent.com/nullpub/fun/main/option.ts";

import {
  flow,
  pipe,
  strictEquals,
  constant,
  identity,
} from "https://raw.githubusercontent.com/nullpub/fun/main/fns.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | Array<JsonValue>;

type Parse<A> = (a: string) => O.Option<[string, A]>;
type char = string;

/* 
 -- Functor --
*/
const map: <A, B>(f: (a: A) => B) => (p: Parse<A>) => Parse<B> = f => p =>
  flow(
    p,
    O.map(([xs, a]) => [xs, f(a)])
  );

/* 
  -- Applicative --
*/
const pure: <A>(a: A) => Parse<A> = a => i => O.some([i, a]);

const ap: <A, B>(p: Parse<(a: A) => B>) => (p2: Parse<A>) => Parse<B> =
  p => p2 => x =>
    pipe(
      p(x),
      O.chain(([xs, f]) =>
        pipe(
          p2(xs),
          O.map(([ys, a]) => [ys, f(a)])
        )
      )
    );
//  mapConstant a -> f b -> f a
const mapConstant: <A, B>(a: A) => (f: Parse<B>) => Parse<A> = a => f =>
  map(constant(a))(f);

// u *> v = (id <$ u) <*> v
const apRight: <A, B>(a: Parse<A>) => (b: Parse<B>) => Parse<B> = a => b => {
  return ap(mapConstant(identity)(a))(b) as typeof b;
};

const liftA2: <A, B, C>(
  f: (a: A) => (b: B) => C
) => (fa: Parse<A>) => (fb: Parse<B>) => Parse<C> = f => fa => fb =>
  ap(map(f)(fa))(fb);

const liftA3: <A, B, C, D>(
  f: (a: A) => (b: B) => (c: C) => D
) => (fa: Parse<A>) => (fb: Parse<B>) => (fc: Parse<C>) => Parse<D> =
  f => fa => fb => fc =>
    ap(ap(map(f)(fa))(fb))(fc);

//u <* v = liftA2 const u v
const apLeft: <A, B>(a: Parse<A>) => (b: Parse<B>) => Parse<A> = a => b =>
  liftA2(constant)(a)(b);

const sequenceA: (f: Array<Parse<string>>) => Parse<string> = ([x, ...xs]) => {
  const concat = (x: string) => (y: string) => {
    return x.concat(y);
  };
  const result = ap(map(concat)(x))(xs.length === 1 ? xs[0] : sequenceA(xs));
  return result;
};

/* 
  -- Alternative --
*/
const empty: Parse<never> = () => O.none;

//    alt :: Parse a -> Parse a -> Parse a
const alt: <A>(p: Parse<A>) => (p2: Parse<A>) => Parse<A> = p => p2 => x =>
  O.alt(p2(x))(p(x));

// some v = (:) <$> v <*> many v
function some<A>(p: Parse<A>): Parse<Array<A>> {
  return (
    input //no point free here, prevent from stack overflow
  ) => liftA2<A, A[], A[]>(x => y => concat(x, y))(p)(many(p))(input);
}
// many v = some v <|> pure []
function many<A>(p: Parse<A>): Parse<Array<A>> {
  return alt(some(p))(pure([]));
}

/*
  -- utils --
*/

function concat<A>(x: A, y: A[]): A[] {
  return [...y, x];
}

//    isDigit :: a -> boolean
const isDigit = <A>(x: A) => !isNaN(Number(x));

//    span :: (a -> Bool) -> [a] -> ([a], [a])
const span: <A>(
  p: (a: A) => boolean
) => (xs: Array<A>) => [Array<A>, Array<A>] = p => xs => {
  return xs.reduce<[typeof xs, typeof xs]>(
    ([ys, zs], x) =>
      p(x) && zs.length === 0 ? [[...ys, x], zs] : [ys, [...zs, x]],
    [[], []]
  );
};

/*
  -- parsers --
*/

const parseChar: (c: char) => Parse<char> = c => input => {
  const [x, ...xs] = Array.from(input);
  return x === c ? O.some([xs.join(""), c]) : O.none;
};

const parseString: (s: string) => Parse<string> = s =>
  sequenceA(Array.from(s).map(parseChar));

//    spanParse :: (Char -> Bool) -> Parse<string>
const spanParse: (f: (a: char) => boolean) => Parse<string> = f => input => {
  const [token, rest] = span(f)(Array.from(input));
  return O.some([rest.join(""), token.join("")]);
};

const jsonNull: Parse<JsonValue> = pipe(
  parseString("null"),
  map(() => null)
);

const notEmptyParser: <A>(p: Parse<A>) => Parse<A> = p => input =>
  pipe(
    p(input),
    // @ts-ignore
    O.chain(([input_, s]) => (s == false ? O.none : O.some([input_, s])))
  );

const jsonBool: Parse<JsonValue> = pipe(
  alt(parseString("true"))(parseString("false")),
  map(strictEquals("true"))
);

const jsonNumber: Parse<JsonValue> = notEmptyParser(
  pipe(spanParse(isDigit), map(Number))
);

const parseBetween: <A>(p1: Parse<A>, p2: Parse<A>, p3: Parse<A>) => Parse<A> =
  (p1, p2, p3) => apRight(p1)(apLeft(p2)(p3)) as typeof p2;

const jsonString: Parse<JsonValue> = parseBetween(
  parseChar('"'),
  spanParse(c => c !== '"'),
  parseChar('"')
);

const ws: Parse<JsonValue> = spanParse(c => c === " ");

function sepBy<A>(sep: Parse<A>, element: Parse<A>): Parse<Array<A>> {
  return pipe(
    pure([]),
    alt(
      pipe(
        many(apRight(sep)(element) as typeof element),
        liftA2<A, A[], A[]>(x => y => concat(x, y))(element)
      )
    )
  );
}

const jsonArray: Parse<JsonValue> = pipe(
  parseBetween(
    parseChar("["),
    parseBetween(
      ws,
      sepBy(parseBetween(ws, parseChar(","), ws), jsonValue),
      ws
    ),
    parseChar("]")
  )
);

const pair = liftA3<string, JsonValue, JsonValue, [string, JsonValue]>(
  key => _ => value => [key, value]
)(jsonString as Parse<string>)(parseBetween(ws, parseChar(":"), ws))(jsonValue);

const jsonObject: Parse<JsonValue> = pipe(
  parseBetween(
    parseChar("{"),
    parseBetween(ws, sepBy(parseBetween(ws, parseChar(","), ws), pair), ws),
    parseChar("}")
  ) as Parse<Array<[string, JsonValue]>>,
  map(x => x.reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}))
);

function jsonValue(input: string): O.Option<[string, JsonValue]> {
  return pipe(
    jsonNull,
    alt(jsonBool),
    alt(jsonNumber),
    alt(jsonString),
    alt(jsonArray),
    alt(jsonObject)
  )(input);
}

/*
  -- execution --
*/

pipe(
  jsonValue('{"a": 12, "c": [1, 2, 3], "b": "hello"}'),
  O.fold(
    () => "error",
    ([rest, parsed]) => parsed
  ),
  x => console.log(x)
);
