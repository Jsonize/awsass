const ChildProcess = require("child_process");

const dockerExec = function (command, callback) {
    ChildProcess.exec(command, function (err, stderr, stdout) {
        callback(err, stderr + stdout);
    });
};

module.exports = {

    login: function (username, password, endpoint, callback) {
        dockerExec(`echo ${password} | docker login -u ${username} --password-stdin ${endpoint}`, callback);
    },

    tag: function (localImageName, imageName, callback) {
        dockerExec(`docker tag ${localImageName} ${imageName}`, callback);
    },

    push: function (imageName, callback) {
        dockerExec(`docker push ${imageName}`, callback);
    }

};