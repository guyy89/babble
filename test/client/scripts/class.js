function request(options) {

    return new Promise((resolve, reject) => {

        var xhr = new XMLHttpRequest();

        xhr.open(options.method, options.action);

        if (options.method === 'post') {

            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');

        }

        xhr.addEventListener('load', e => {

            resolve(e.target.responseText);

        });

        xhr.send(options.data);

    });

}