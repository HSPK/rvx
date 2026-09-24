use crate::TrackerError;

#[derive(Clone, Debug)]
pub(crate) enum Window {
    Points(usize),
    Duration(i64),
}

#[derive(Clone, Debug)]
pub(crate) enum Expr {
    Number(f64),
    Duration(i64),
    Metric(String, Option<Window>),
    Call(String, Vec<Expr>),
    Unary(UnaryOp, Box<Expr>),
    Binary(BinaryOp, Box<Expr>, Box<Expr>),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum UnaryOp {
    Neg,
    Pos,
    Not,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(f64),
    Duration(i64),
    Ident(String),
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Not,
    End,
}

struct Lexer<'a> {
    input: &'a str,
    index: usize,
}

impl<'a> Lexer<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, index: 0 }
    }

    fn tokens(mut self) -> Result<Vec<Token>, TrackerError> {
        let mut tokens = Vec::new();
        loop {
            let token = self.next_token()?;
            let end = token == Token::End;
            tokens.push(token);
            if end {
                return Ok(tokens);
            }
        }
    }

    fn next_token(&mut self) -> Result<Token, TrackerError> {
        self.skip_space();
        let Some(character) = self.peek() else {
            return Ok(Token::End);
        };
        if character.is_ascii_digit()
            || character == '.' && self.peek_next().is_some_and(|v| v.is_ascii_digit())
        {
            return self.number();
        }
        if matches!(character, '"' | '\'' | '`') {
            return self.quoted();
        }
        if is_ident_start(character) {
            return Ok(self.identifier());
        }
        self.index += character.len_utf8();
        let token = match character {
            '(' => Token::LParen,
            ')' => Token::RParen,
            '[' => Token::LBracket,
            ']' => Token::RBracket,
            ',' => Token::Comma,
            '+' => Token::Plus,
            '-' => Token::Minus,
            '*' => Token::Star,
            '/' => Token::Slash,
            '%' => Token::Percent,
            '!' if self.consume('=') => Token::Ne,
            '!' => Token::Not,
            '=' if self.consume('=') => Token::Eq,
            '<' if self.consume('=') => Token::Le,
            '<' => Token::Lt,
            '>' if self.consume('=') => Token::Ge,
            '>' => Token::Gt,
            '&' if self.consume('&') => Token::And,
            '&' => Token::And,
            '|' if self.consume('|') => Token::Or,
            '|' => Token::Or,
            _ => {
                return Err(TrackerError::InvalidInput(format!(
                    "unexpected alert expression character {character:?}"
                )))
            }
        };
        Ok(token)
    }

    fn number(&mut self) -> Result<Token, TrackerError> {
        let start = self.index;
        let mut exponent = false;
        while let Some(character) = self.peek() {
            if character.is_ascii_digit() || character == '.' {
                self.index += 1;
            } else if matches!(character, 'e' | 'E') && !exponent {
                exponent = true;
                self.index += 1;
                if self.peek().is_some_and(|value| matches!(value, '+' | '-')) {
                    self.index += 1;
                }
            } else {
                break;
            }
        }
        let number: f64 = self.input[start..self.index]
            .parse()
            .map_err(|_| TrackerError::InvalidInput("invalid alert number".into()))?;
        let unit_start = self.index;
        while self.peek().is_some_and(|value| value.is_ascii_alphabetic()) {
            self.index += 1;
        }
        let unit = &self.input[unit_start..self.index];
        if unit.is_empty() {
            return Ok(Token::Number(number));
        }
        let multiplier = match unit {
            "ns" => 1.0,
            "us" => 1_000.0,
            "ms" => 1_000_000.0,
            "s" => 1_000_000_000.0,
            "m" => 60.0 * 1_000_000_000.0,
            "h" => 3_600.0 * 1_000_000_000.0,
            "d" => 86_400.0 * 1_000_000_000.0,
            _ => {
                return Err(TrackerError::InvalidInput(format!(
                    "unknown alert duration unit {unit:?}"
                )))
            }
        };
        Ok(Token::Duration((number * multiplier) as i64))
    }

    fn quoted(&mut self) -> Result<Token, TrackerError> {
        let quote = self.peek().unwrap();
        self.index += quote.len_utf8();
        let start = self.index;
        while let Some(character) = self.peek() {
            if character == quote {
                let value = self.input[start..self.index].to_string();
                self.index += quote.len_utf8();
                return Ok(Token::Ident(value));
            }
            self.index += character.len_utf8();
        }
        Err(TrackerError::InvalidInput(
            "unterminated quoted metric name".into(),
        ))
    }

    fn identifier(&mut self) -> Token {
        let start = self.index;
        while self.peek().is_some_and(is_ident_continue) {
            self.index += self.peek().unwrap().len_utf8();
        }
        let value = &self.input[start..self.index];
        match value.to_ascii_lowercase().as_str() {
            "and" => Token::And,
            "or" => Token::Or,
            "not" => Token::Not,
            _ => Token::Ident(value.to_string()),
        }
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.index += self.peek().unwrap().len_utf8();
        }
    }

    fn peek(&self) -> Option<char> {
        self.input[self.index..].chars().next()
    }

    fn peek_next(&self) -> Option<char> {
        let mut characters = self.input[self.index..].chars();
        characters.next();
        characters.next()
    }

    fn consume(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.index += expected.len_utf8();
            true
        } else {
            false
        }
    }
}

fn is_ident_start(value: char) -> bool {
    value.is_ascii_alphabetic() || value == '_'
}

fn is_ident_continue(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | '/' | '@')
}

pub(crate) struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    pub(crate) fn parse(input: &str) -> Result<Expr, TrackerError> {
        let mut parser = Self {
            tokens: Lexer::new(input).tokens()?,
            index: 0,
        };
        let expression = parser.or_expression()?;
        if !matches!(parser.current(), Token::End) {
            return Err(TrackerError::InvalidInput(
                "unexpected trailing alert expression input".into(),
            ));
        }
        Ok(expression)
    }

    fn or_expression(&mut self) -> Result<Expr, TrackerError> {
        let mut expression = self.and_expression()?;
        while self.take(&Token::Or) {
            expression = Expr::Binary(
                BinaryOp::Or,
                Box::new(expression),
                Box::new(self.and_expression()?),
            );
        }
        Ok(expression)
    }

    fn and_expression(&mut self) -> Result<Expr, TrackerError> {
        let mut expression = self.comparison()?;
        while self.take(&Token::And) {
            expression = Expr::Binary(
                BinaryOp::And,
                Box::new(expression),
                Box::new(self.comparison()?),
            );
        }
        Ok(expression)
    }

    fn comparison(&mut self) -> Result<Expr, TrackerError> {
        let mut previous = self.additive()?;
        let mut expression = None;
        loop {
            let operation = match self.current() {
                Token::Eq => BinaryOp::Eq,
                Token::Ne => BinaryOp::Ne,
                Token::Lt => BinaryOp::Lt,
                Token::Le => BinaryOp::Le,
                Token::Gt => BinaryOp::Gt,
                Token::Ge => BinaryOp::Ge,
                _ => break,
            };
            self.index += 1;
            let right = self.additive()?;
            let comparison = Expr::Binary(operation, Box::new(previous), Box::new(right.clone()));
            expression = Some(match expression {
                Some(expression) => {
                    Expr::Binary(BinaryOp::And, Box::new(expression), Box::new(comparison))
                }
                None => comparison,
            });
            previous = right;
        }
        Ok(expression.unwrap_or(previous))
    }

    fn additive(&mut self) -> Result<Expr, TrackerError> {
        let mut expression = self.term()?;
        loop {
            let operation = match self.current() {
                Token::Plus => BinaryOp::Add,
                Token::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.index += 1;
            expression = Expr::Binary(operation, Box::new(expression), Box::new(self.term()?));
        }
        Ok(expression)
    }

    fn term(&mut self) -> Result<Expr, TrackerError> {
        let mut expression = self.unary()?;
        loop {
            let operation = match self.current() {
                Token::Star => BinaryOp::Mul,
                Token::Slash => BinaryOp::Div,
                Token::Percent => BinaryOp::Mod,
                _ => break,
            };
            self.index += 1;
            expression = Expr::Binary(operation, Box::new(expression), Box::new(self.unary()?));
        }
        Ok(expression)
    }

    fn unary(&mut self) -> Result<Expr, TrackerError> {
        let operation = match self.current() {
            Token::Minus => Some(UnaryOp::Neg),
            Token::Plus => Some(UnaryOp::Pos),
            Token::Not => Some(UnaryOp::Not),
            _ => None,
        };
        if let Some(operation) = operation {
            self.index += 1;
            return Ok(Expr::Unary(operation, Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Expr, TrackerError> {
        let mut expression = match self.current().clone() {
            Token::Number(value) => {
                self.index += 1;
                Expr::Number(value)
            }
            Token::Duration(value) => {
                self.index += 1;
                Expr::Duration(value)
            }
            Token::Ident(name) => {
                self.index += 1;
                if self.take(&Token::LParen) {
                    let mut arguments = Vec::new();
                    if !self.take(&Token::RParen) {
                        loop {
                            arguments.push(self.or_expression()?);
                            if self.take(&Token::RParen) {
                                break;
                            }
                            self.expect(&Token::Comma)?;
                        }
                    }
                    Expr::Call(name, arguments)
                } else {
                    Expr::Metric(name, None)
                }
            }
            Token::LParen => {
                self.index += 1;
                let expression = self.or_expression()?;
                self.expect(&Token::RParen)?;
                expression
            }
            token => {
                return Err(TrackerError::InvalidInput(format!(
                    "unexpected alert token {token:?}"
                )))
            }
        };
        if self.take(&Token::LBracket) {
            let window = match self.current().clone() {
                Token::Number(value) if value >= 1.0 && value.fract() == 0.0 => {
                    self.index += 1;
                    Window::Points(value as usize)
                }
                Token::Duration(value) if value > 0 => {
                    self.index += 1;
                    Window::Duration(value)
                }
                _ => {
                    return Err(TrackerError::InvalidInput(
                        "metric window must be a positive integer or duration".into(),
                    ))
                }
            };
            self.expect(&Token::RBracket)?;
            let Expr::Metric(name, _) = expression else {
                return Err(TrackerError::InvalidInput(
                    "windows may only follow metric names".into(),
                ));
            };
            expression = Expr::Metric(name, Some(window));
        }
        Ok(expression)
    }

    fn current(&self) -> &Token {
        self.tokens.get(self.index).unwrap_or(&Token::End)
    }

    fn take(&mut self, expected: &Token) -> bool {
        if self.current() == expected {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: &Token) -> Result<(), TrackerError> {
        if self.take(expected) {
            Ok(())
        } else {
            Err(TrackerError::InvalidInput(format!(
                "expected {expected:?}, got {:?}",
                self.current()
            )))
        }
    }
}
