const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'currency-converter-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

let baseExchangeRates = {};
let users = [];

async function loadData() {
    try {
        const ratesData = await fs.readFile(path.join(__dirname, 'data', 'exchange-rates.json'), 'utf8');
        baseExchangeRates = JSON.parse(ratesData);
        console.log('Базовые курсы валют загружены');

        const usersData = await fs.readFile(path.join(__dirname, 'data', 'users.json'), 'utf8');
        users = JSON.parse(usersData);
        console.log('Пользователи загружены:', users.length);
    } catch (error) {
        console.error('Ошибка загрузки данных:', error);
        baseExchangeRates = {};
        users = [];
    }
}

async function saveUsers() {
    try {
        await fs.writeFile(
            path.join(__dirname, 'data', 'users.json'),
            JSON.stringify(users, null, 2)
        );
        return true;
    } catch (error) {
        console.error('Ошибка сохранения пользователей:', error);
        return false;
    }
}

function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

function getUserRates(user) {
    return user.personalRates || { ...baseExchangeRates };
}

function convertCurrency(amount, fromCurrency, toCurrency, userRates) {
    if (!userRates[fromCurrency] || !userRates[toCurrency]) {
        throw new Error('Неизвестная валюта');
    }
    
    const amountInUSD = amount / userRates[fromCurrency];
    const convertedAmount = amountInUSD * userRates[toCurrency];
    
    return parseFloat(convertedAmount.toFixed(4));
}

app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('login', { 
        title: 'Вход',
        error: req.query.error,
        message: req.query.message
    });
});

app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('register', { 
        title: 'Регистрация',
        error: req.query.error
    });
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.redirect('/login?error=Все поля обязательны');
        }

        const user = users.find(u => u.username === username);
        if (!user) {
            return res.redirect('/login?error=Пользователь не найден');
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.redirect('/login?error=Неверный пароль');
        }

        req.session.user = { id: user.id, username: user.username };
        res.redirect('/');

    } catch (error) {
        res.redirect('/login?error=Ошибка сервера');
    }
});

app.post('/register', async (req, res) => {
    try {
        const { username, password, confirmPassword } = req.body;
        
        if (!username || !password || !confirmPassword) {
            return res.redirect('/register?error=Все поля обязательны');
        }

        if (password !== confirmPassword) {
            return res.redirect('/register?error=Пароли не совпадают');
        }

        if (users.find(u => u.username === username)) {
            return res.redirect('/register?error=Пользователь уже существует');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: randomUUID(),
            username,
            password: hashedPassword,
            personalRates: { ...baseExchangeRates },
        };

        users.push(newUser);
        const saved = await saveUsers();

        if (saved) {
            res.redirect('/login?message=Регистрация успешна. Войдите в систему');
        } else {
            res.redirect('/register?error=Ошибка при сохранении');
        }

    } catch (error) {
        res.redirect('/register?error=Ошибка сервера');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
    const userRates = getUserRates(users.find(u => u.id === req.session.user.id));
    res.render('index', { 
        currencies: Object.keys(userRates),
        title: 'Конвертер валют',
        user: req.session.user
    });
});

app.post('/convert', requireAuth, (req, res) => {
    try {
        const user = users.find(u => u.id === req.session.user.id);
        const userRates = getUserRates(user);
        const { amount, fromCurrency, toCurrency } = req.body;
        
        if (!amount || !fromCurrency || !toCurrency) {
            return res.status(400).render('convert', {
                error: 'Все поля обязательны для заполнения',
                amount,
                fromCurrency,
                toCurrency,
                currencies: Object.keys(userRates),
                user: req.session.user
            });
        }

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).render('convert', {
                error: 'Введите корректную сумму',
                amount,
                fromCurrency,
                toCurrency,
                currencies: Object.keys(userRates),
                user: req.session.user
            });
        }

        const result = convertCurrency(numericAmount, fromCurrency, toCurrency, userRates);
        
        res.render('convert', {
            amount: numericAmount,
            fromCurrency,
            toCurrency,
            result,
            currencies: Object.keys(userRates),
            success: true,
            error: null,
            user: req.session.user
        });

    } catch (error) {
        const userRates = getUserRates(users.find(u => u.id === req.session.user.id));
        res.status(400).render('convert', {
            error: error.message,
            amount: req.body.amount,
            fromCurrency: req.body.fromCurrency,
            toCurrency: req.body.toCurrency,
            currencies: Object.keys(userRates),
            success: false,
            user: req.session.user
        });
    }
});

app.get('/rates', requireAuth, (req, res) => {
    const userRates = getUserRates(users.find(u => u.id === req.session.user.id));
    res.render('rates', {
        rates: userRates,
        title: 'Мои курсы валют',
        user: req.session.user
    });
});


app.get('/admin/rates', requireAuth, (req, res) => {
    const userRates = getUserRates(users.find(u => u.id === req.session.user.id));
    res.render('admin-rates', {
        rates: userRates,
        title: 'Мой редактор курсов',
        message: req.query.message,
        user: req.session.user
    });
});

app.post('/admin/rates/update', requireAuth, async (req, res) => {
    try {
        const user = users.find(u => u.id === req.session.user.id);
        const { currency, rate } = req.body;
        
        if (!currency || !rate) {
            return res.redirect('/admin/rates?message=Все поля обязательны для заполнения');
        }

        const numericRate = parseFloat(rate);
        if (isNaN(numericRate) || numericRate <= 0) {
            return res.redirect('/admin/rates?message=Введите корректное значение курса');
        }

        if (!user.personalRates) {
            user.personalRates = { ...baseExchangeRates };
        }
        user.personalRates[currency] = numericRate;
        
        const saved = await saveUsers();
        
        if (saved) {
            res.redirect('/admin/rates?message=Курс успешно обновлен');
        } else {
            res.redirect('/admin/rates?message=Ошибка при сохранении');
        }

    } catch (error) {
        res.redirect('/admin/rates?message=Ошибка сервера');
    }
});

app.post('/admin/rates/add', requireAuth, async (req, res) => {
    try {
        const user = users.find(u => u.id === req.session.user.id);
        const { newCurrency, newRate } = req.body;
        
        if (!newCurrency || !newRate) {
            return res.redirect('/admin/rates?message=Все поля обязательны для заполнения');
        }

        if (!user.personalRates) {
            user.personalRates = { ...baseExchangeRates };
        }

        if (user.personalRates[newCurrency]) {
            return res.redirect('/admin/rates?message=Валюта уже существует');
        }

        const numericRate = parseFloat(newRate);
        if (isNaN(numericRate) || numericRate <= 0) {
            return res.redirect('/admin/rates?message=Введите корректное значение курса');
        }

        user.personalRates[newCurrency] = numericRate;
        
        const saved = await saveUsers();
        
        if (saved) {
            res.redirect('/admin/rates?message=Валюта успешно добавлена');
        } else {
            res.redirect('/admin/rates?message=Ошибка при сохранении');
        }

    } catch (error) {
        res.redirect('/admin/rates?message=Ошибка сервера');
    }
});

app.post('/admin/rates/delete', requireAuth, async (req, res) => {
    try {
        const user = users.find(u => u.id === req.session.user.id);
        const { currencyToDelete } = req.body;
        
        if (!currencyToDelete) {
            return res.redirect('/admin/rates?message=Выберите валюту для удаления');
        }

        if (!user.personalRates) {
            user.personalRates = { ...baseExchangeRates };
        }

        if (!user.personalRates[currencyToDelete]) {
            return res.redirect('/admin/rates?message=Валюта не найдена');
        }

        if (currencyToDelete === 'USD') {
            return res.redirect('/admin/rates?message=Нельзя удалить базовую валюту USD');
        }
        delete user.personalRates[currencyToDelete];
        const saved = await saveUsers();
        
        if (saved) {
            res.redirect('/admin/rates?message=Валюта успешно удалена');
        } else {
            res.redirect('/admin/rates?message=Ошибка при сохранении');
        }

    } catch (error) {
        res.redirect('/admin/rates?message=Ошибка сервера');
    }
});

app.post('/admin/rates/reset', requireAuth, async (req, res) => {
    try {
        const user = users.find(u => u.id === req.session.user.id);
        
        user.personalRates = { ...baseExchangeRates };
        
        const saved = await saveUsers();
        
        if (saved) {
            res.redirect('/admin/rates?message=Курсы сброшены к базовым значениям');
        } else {
            res.redirect('/admin/rates?message=Ошибка при сохранении');
        }

    } catch (error) {
        res.redirect('/admin/rates?message=Ошибка сервера');
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', { 
        message: 'Что-то пошло не так!',
        user: req.session?.user 
    });
});

async function startServer() {
    await loadData();
    
    app.listen(PORT, () => {
        console.log(`Сервер запущен на http://localhost:${PORT}`);
        console.log('Доступные маршруты:');
        console.log('  /login - Вход в систему');
        console.log('  /register - Регистрация');
        console.log('  / - Конвертер валют (после входа)');
        console.log('  /rates - Мои курсы валют');
        console.log('  /admin/rates - Редактор курсов');
    });
}

startServer().catch(console.error);